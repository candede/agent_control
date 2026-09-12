# Phase 03 - Permission Center And Feature Gating

## Status

```yaml
phase_file: 03-permission-center-ui.md
phase_status: complete
outcome: completed_with_disabled_capabilities
validated_at_utc: 2026-09-08T17:19:45Z
execution_target: retained local Docker project agent-control-phase01; synthetic isolated browser/database fixtures; no cloud or provider changes
```

Phase 03 is implemented and locally qualified. The retained app is healthy at **http://localhost:3001** and sign-in remains explicitly unconfigured. Real Entra/provider evidence is unavailable without approved credentials; synthetic browser evidence is not provider qualification. No Phase 04 adapter, provider grant, Azure deployment, commit, push, campaign ledger, prompt hash or future-ideas implementation was created.

## Delivered Contracts

- **Permission Center:** [PermissionCenter.tsx](../../../frontend/src/components/PermissionCenter.tsx) renders only the six registered adapters: delegated/application package reads, package access/block qualification, directory lookup and local official report import. Unregistered Power Platform, Purview, Defender and reassignment definitions remain absent. New adapters can use the same row renderer without component permission constants.
- **Requirements and remediation:** Rows expose exact backend permission/mode/audience, required Microsoft and independent internal roles, licensing, cloud/API maturity, configuration/environment, unlocked purpose, last probe/success/expiry, write qualification, Microsoft documentation and safe evidence. Preview badges are keyboard-focusable and explain configuration/change risk. Native expandable evidence panels and setup dialogs retain readable text at narrow widths.
- **Explicit actions:** Capability-specific consent, current-principal non-mutating probe retry, status reload, Entra/Microsoft admin portals and setup instructions remain separate from provider availability. Consent cannot assign roles, grants or licenses. Unknown/expired evidence never enables provider actions. There are no recurring probes or catalog refreshes on navigation.
- **Shared gates:** [CapabilityGate.tsx](../../../frontend/src/components/CapabilityGate.tsx), [capabilityContext.ts](../../../frontend/src/capabilityContext.ts), [capabilityState.ts](../../../frontend/src/capabilityState.ts) and [useCapabilities.ts](../../../frontend/src/useCapabilities.ts) cover shell navigation, package refresh/detail/export actions, row/bulk controls, access dialogs, import confirmation and unsent-job resume. Local data-role decisions are separate from provider availability. A successful read cannot enable an unqualified write. Disabled controls have adjacent, screen-reader-associated explanations and a path to Permissions.
- **Roles and saved data:** [App.tsx](../../../frontend/src/App.tsx) retains Reader catalog scope, Operator control scope, SecurityReader audit/user-level scope and Administrator import scope. Administrator-only accounts have a Report import view, not implicit report-read access. Permissions remains reachable even with no assigned role. Loaded catalog data/fast export, saved reports and authorized local audit are not denied by provider outages. Full detail exports still require a fresh provider read. Browser report authority remains `agent-control:usage-reports:v1`; parsing, storage and logout cleanup are unchanged pending Phase 06.
- **Freshness and isolation:** Expiry schedules only a local UI update, never a provider request. Evidence is hidden immediately when the loaded account changes; generation checks discard prior pending responses. The compact global health control counts active available/degraded/blocked decisions and opens Permissions. Backend data scopes and route policies remain the security boundary.
- **API contract:** [frontend API client](../../../frontend/src/api/client.ts) imports capability/role types directly from [backend types](../../../backend/src/types/capability.ts), replacing the frontend's copied type declarations. [CapabilityService](../../../backend/src/services/capabilities.ts) exposes only an allowlisted error category and validated correlation ID, not stored/raw provider objects. Existing status, authorization, freshness and preview qualification fields remain independent.
- **Auth integration:** Current [auth.ts](../../../backend/src/routes/auth.ts) was inspected rather than inferred from the Phase 02 handoff. Its coordinated account-session activation/validation, all-settled login/logout cleanup and one-time ephemeral flow consumption were preserved. Consent now rejects unregistered adapters. Provider callback errors consume the flow before returning a fixed local cancellation/interaction-required/failed outcome; error descriptions and transaction values are not reflected into UI messages. Raw-session and callback replay/role-revocation tests continue to pass.
- **Container test foundation:** [frontend/vitest.config.ts](../../../frontend/vitest.config.ts) and [test setup](../../../frontend/src/test/setup.ts) provide React Testing Library, jsdom and DOM axe. [Playwright config](../../../frontend/playwright.config.ts), [browser workflows](../../../frontend/browser/permissions.spec.ts), [fixture app](../../../backend/scripts/browser-fixture.browser.ts), [fixture config](../../../backend/scripts/browser-fixture.config.ts), [PowerShell entry point](../../../scripts/permission-browser.tests.ps1) and the `permission-browser-test` [Docker target](../../../Dockerfile) provide Chromium and rendered axe checks. Test packages came from the configured Microsoft npm feed; no host application/browser toolchain or managed-device bypass was used.
- **Production exclusion:** The fixture runs real Express routing, API policy, capability decisions, PostgreSQL sessions and scoped evidence with deterministic test-only auth/provider mocks. It is not a runtime auth route. [Runtime configuration](../../../backend/src/config.ts) rejects `AGENT_CONTROL_FIXTURE_MODE` in every environment. The actual production image was checked for absence of fixture scripts, Playwright, Testing Library, jsdom and axe.
- **Persistence:** No schema migration was required. Applied migrations 1, 2, 3 and 4 were not edited. Current migration/checksum, session/role concurrency, capability isolation, durable-job and saved-audit contracts were verified through current-worktree tests. The original named volume and restricted secret files were retained; the existing persistence harness proved data/secret/origin continuity across restart and repeated deployment.

## Changed Files

- Backend: [types/capability.ts](../../../backend/src/types/capability.ts), [services/capabilities.ts](../../../backend/src/services/capabilities.ts) and [tests](../../../backend/src/services/capabilities.test.ts) add safe diagnostic projection; [routes/auth.ts](../../../backend/src/routes/auth.ts) and [app.test.ts](../../../backend/src/app.test.ts) cover safe consent return and direct denied writes; [config.ts](../../../backend/src/config.ts) and [config.test.ts](../../../backend/src/config.test.ts) reject fixture runtime modes. Browser fixture/configuration files are linked above.
- Frontend: [App.tsx](../../../frontend/src/App.tsx), [authorization.ts](../../../frontend/src/authorization.ts), [authorization tests](../../../frontend/src/authorization.test.ts), [api/client.ts](../../../frontend/src/api/client.ts); new capability context/state/hook and [state tests](../../../frontend/src/capabilityState.test.ts), [hook tests](../../../frontend/src/useCapabilities.test.tsx); new Permission Center/gate/[styles](../../../frontend/src/components/permissions.css)/[component tests](../../../frontend/src/components/PermissionCenter.test.tsx); gated [AgentTable](../../../frontend/src/components/AgentTable.tsx), [BulkActions](../../../frontend/src/components/BulkActions.tsx), [AccessAssignmentModal](../../../frontend/src/components/AccessAssignmentModal.tsx) and [AgentDetailModal](../../../frontend/src/components/AgentDetailModal.tsx). Test configuration, browser spec and setup are linked above.
- Root/docs/tooling: [frontend/package.json](../../../frontend/package.json), [package-lock.json](../../../package-lock.json), [Dockerfile](../../../Dockerfile), [browser orchestration](../../../scripts/permission-browser.tests.ps1), [README.md](../../../README.md), [security-model.md](../../../docs/security-model.md), and this completion record.
- Checked and unchanged: applied schema migrations; backend route-policy/data-scope registry and persistence authorities; Compose and local deployment entry point; report storage/parser authority; the Phase 01/02 completion records; legacy Azure deployment assets and infrastructure. Existing worktree changes, including the post-handoff auth changes, were preserved.

## Validation Evidence

Final worktree, not a committed revision. All application, build, database and browser tools executed in Docker. PowerShell orchestration/document checks, Git and host process inspection ran on the host.

| Check / exact command | Environment / revision | Status | Observed result and safe evidence |
| --- | --- | --- | --- |
| `docker run --rm --mount "type=bind,source=$PWD/backend/src,target=/app/backend/src,readonly" --entrypoint npm agent-control-phase01-operator:local run test --workspace backend -- src/services/capabilities.test.ts src/auth/flows.test.ts src/db/sessionsConcurrency.test.ts` | First contract edit, current source mounted into retained operator image | passed | 15 capability/ephemeral-flow/concurrent-session checks. |
| Focused backend command below, targeting `src/app.test.ts src/config.test.ts src/services/capabilities.test.ts` | Generated control/fixture databases, current source | passed | 30 checks, including consumed callback cancellation/Conditional Access, no error-description reflection, replay denial, denied direct writes without job creation and production fixture-mode rejection. |
| Focused frontend command below; earlier slice also run immediately after component/state edits | Docker jsdom/Testing Library | passed | 32 phase-focused checks: 17 component/DOM-axe, 12 state, two hook isolation/expiry and one independent-role matrix test, all included in the final aggregate. Component actions use the existing API client and assert CSRF/request payloads. |
| `pwsh -NoProfile -File ./scripts/permission-browser.tests.ps1 -Project agent-control-phase01` | Built React + real Express/capability/policy/session stack; isolated PostgreSQL; Chromium 1440x1000 and 360x780; final run 17:11 UTC | passed | 28 browser checks. Every status, exact permission/role text, inactive-adapter absence, loading, explicit probes, safe consent cancellation, saved catalog/export, direct write denial, four-role separation, current-principal evidence, saved audit during outage, keyboard panels/dialog focus return. Rendered axe WCAG A/AA including contrast: zero violations. No page errors or Permission Center horizontal overflow. [JSON report](../../../artifacts/phase03/permission-browser-results.json). |
| `pwsh -NoProfile -File ./deploy-local.ps1 -Action Test -Project agent-control-phase01`, then `pwsh -NoProfile -File ./deploy-local.ps1 -Project agent-control-phase01` | Retained installation, final source at 17:14 UTC | passed | Final aggregate: 144 backend tests in 22 files; 65 frontend tests in nine files; backend typecheck, frontend lint and both builds. App and PostgreSQL healthy at canonical `http://localhost:3001`; sign-in honestly unconfigured. |
| `pwsh -NoProfile -File ./scripts/persistence.tests.ps1 -Project agent-control-phase01` | Retained project plus nonempty isolated fixture and isolated native restore | passed | Data fingerprints, exact secret bytes, tenant/client/port settings, stop/start, full redeploy and native restore passed. The aggregate passed again. Test DBs, restore target and generated backup/receipt pairs removed. |
| `docker run --rm --network agent-control-phase01_default agent-control-phase01-operator:local backend/scripts/package-smoke.ts http://app:3001` | Deployed combined app | passed | Health/readiness, deep links/assets/cache, API404/callback errors, traversal and anonymous diagnostics protection passed. No ZIP/cloud deployment claim. |
| Production image command below | Actual `agent-control-phase01-app:local` image | passed | Fixture-mode rejection executed; fixture scripts, Playwright, Testing Library, jsdom and axe absent. |
| `docker build --target browser-test -t agent-control-phase03-signin:local .` then `docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/artifacts,target=/evidence" agent-control-phase03-signin:local` | Normal retained app, not the fixture app | passed | Desktop/mobile sign-in-unconfigured UI, callback guidance, no page errors and no horizontal overflow. |
| `pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1`; PowerShell AST/link checks; `git diff --check`; editor diagnostics | Host orchestration plus authoritative Docker compilation | passed | 19 preservation/orchestration assertions, new script syntax and local Markdown links passed; touched source diagnostics clear. |
| Compose `ps`, PostgreSQL inventory and host application-process check | After all validation cleanup | passed | Exactly two healthy retained services; schema `[1,2,3,4]`; only `agentcontrol` and `postgres` non-template databases; no host Vite/backend server. |
| Live Entra consent/probes, preview write canaries, Azure deployment | No approved credentials or remote-change scope | unavailable | No provider calls, grants, role changes or remote writes were made. Unqualified writes and future adapters remain unavailable. |

### Exact Focused Commands

After the operator image is built, component/state/expiry/role tests need no database:

```bash
docker run --rm --entrypoint npm agent-control-phase01-operator:local \
  run test --workspace frontend -- src/components/PermissionCenter.test.tsx \
  src/capabilityState.test.ts src/useCapabilities.test.tsx src/authorization.test.ts
```

Backend focused tests use an independently created random `agentcontrol_test_*` control database. The test helper creates/drops its own migrated databases. The control database is dropped in the invoking PowerShell `finally`, not against demo storage:

```bash
docker run --rm --network agent-control-phase01_default \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" \
  --mount "type=bind,source=$PWD/backend/src,target=/app/backend/src,readonly" \
  -e PGHOST=postgres -e PGUSER=agentcontrol_admin -e PGDATABASE=<created-agentcontrol_test_name> \
  -e PGPASSWORD_FILE=/run/secrets/postgres-admin -e APP_PGPASSWORD_FILE=/run/secrets/postgres-app \
  --entrypoint npm agent-control-phase01-operator:local run test --workspace backend -- \
  src/app.test.ts src/config.test.ts src/services/capabilities.test.ts
```

The checked-in browser entry point owns exact creation/run/cleanup commands. Network: `agent-control-phase01_default`; PostgreSQL hostname: `postgres`; canonical app/browser base URL: `http://localhost:3001` **inside the disposable test container**. No fixture port is published, so the retained demo's host origin and browser storage are untouched. The final browser fixture database was `agentcontrol_test_f0fd228f6122432494f2f949762d16e1`; it and its random control database were dropped. The fixture server/store stop in test teardown and `docker run --rm` removes the test container. No extra long-running service remains.

Production-image proof:

```bash
docker run --rm --entrypoint node agent-control-phase01-app:local --input-type=module -e '
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
for (const filename of ["backend/scripts/browser-fixture.browser.ts", "node_modules/@playwright/test", "node_modules/@testing-library/react", "node_modules/jsdom", "node_modules/axe-core"]) assert.equal(existsSync(filename), false, filename);
process.env.AGENT_CONTROL_FIXTURE_MODE="browser";
const {validateRuntimeConfig}=await import("./backend/dist/config.js");
assert.throws(validateRuntimeConfig, /Fixture authentication is forbidden/);
console.log("Production fixture-mode rejection and test dependency exclusions: passed");'
```

### Repairs And Visual Evidence

- The first component run passed 28/29 checks but jsdom did not synthesize native Enter activation for `<details>`. DOM tests now check supported expansion; Chromium separately proves native Enter activation, tab containment and Escape/focus return. The same component suite passed after repair; no accessibility rule was dropped except DOM-only contrast, which is checked in Chromium.
- The first browser run passed 17/28 and exposed the existing mobile navigation's no-wrap behavior, dialog focus reaching browser chrome, and a shared synthetic evidence row changed by an earlier probe. Navigation now wraps with stable minimum button widths; setup dialogs explicitly cycle Tab/Shift+Tab; fixture login reseeds the exact synthetic principal's evidence. The same 28 checks passed after repair and again after strengthening loading/import workflows.
- Review caught Administrator-only report import becoming unreachable with the new default Permissions view. A separately gated local import view restores that operation without assigning any data-read role. Component/role and browser regressions pass.
- The old generic 403 advice to request write permission was removed. Errors now direct users to exact capability requirements instead of inferring grants or provider roles.
- Inspected synthetic screenshots: [desktop Permission Center](../../../artifacts/phase03/permissions-available-desktop.png), [mobile Permission Center](../../../artifacts/phase03/permissions-missing_permission-mobile.png), [mobile exact permission row](../../../artifacts/phase03/permission-row-missing_permission-mobile.png), [desktop state row](../../../artifacts/phase03/permission-row-preview_disabled-desktop.png). All ten status fixtures have viewport and row screenshots for both sizes. These are UI state fixtures, not evidence that a provider returned those statuses or that a stable read endpoint needs write qualification.

## Open Issues

No new implementation, accessibility, data-loss or cleanup issue remains. Inherited [P01-LIVE-IDENTITY and P01-BUNDLE-SIZE](01-domain-persistence-foundations.md#open-issues) remain open. Live identity/provider checks are unavailable without approved setup; backend enforcement and visible disabled controls contain that limitation. The current main bundle is 751.69 kB minified / 218.68 kB gzip and still produces Vite's existing 500 kB warning; Phase 10 owns integrated loading measurement and splitting. No warning threshold was suppressed.

## Next Session

- Implement only [04-power-platform-inventory.md](../04-power-platform-inventory.md) in a fresh session. No Phase 04 implementation was started here.
- Reuse backend capability definitions/types, current-principal evidence scopes, independent roles, route policies, PostgreSQL ownership and the shared UI gate. The Power Platform adapter is still unregistered; registration must follow implementation/probe evidence, not a UI constant or synthetic success.
- Reuse the retained `agent-control-phase01` project and the Docker-only browser/component harness. Add any required schema through a new additive migration, never by modifying migrations 1-4. Keep browser-local reports unchanged until Phase 06 and completed/uncertain writes unreplayed. Current ordinary Admin-confirmed operations require actual provider authorization, not prior canary qualification.
- Read the binding README and Phase 01/02/03 records, then verify the current producer/consumer paths against the actual worktree. Preserve the post-handoff auth/session protections and safe callback outcomes.

```text
Implement only plans/admin-poc-production/04-power-platform-inventory.md.
Read the binding README, that phase's prerequisites, and Phase 01/02/03
completion records; verify relevant current-worktree contracts before editing.
Use the retained agent-control-phase01 Docker project and canonical origin,
isolated fixture databases, existing restricted secrets and Microsoft npm feed.
Preserve migrations 1-4, backend role/data scopes, current-principal evidence,
ephemeral tokens/transactions, browser-local reports and no-write-replay rules.
Do not commit, push, deploy Azure, change provider grants, create a campaign
ledger/prompt hashes, execute future ideas or advance beyond Phase 04.
Implement, validate and write only Phase 04's completion record, then stop.
```