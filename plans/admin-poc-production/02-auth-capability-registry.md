# Phase 02 - Multi-Resource Authentication and Capability Registry

## Mission

Replace the single hard-coded Graph consent bundle with backend-owned multi-resource authentication, internal application RBAC, and a capability registry that states and probes exact Microsoft permissions, roles, licensing, configuration, cloud, and API maturity.

## Prerequisites

- Follow the roadmap's manual fresh-session contract and read `completions/01-domain-persistence-foundations.md`; use its actual delivered module/test paths.
- Phase 01 PostgreSQL sessions/jobs, audit, scoped repositories, Docker-only local script and combined-app contract must exist. This phase owns minimal provider configuration, capability evidence, route/data-access policy and administrator setup guidance, not a credential-storage framework.
- Do not deploy to Azure in this phase; local Docker deployment/validation is required.

## Read first

- `backend/src/config.ts`
- `backend/src/auth/msal.ts`
- `backend/src/routes/auth.ts`
- `backend/src/middleware/auth.ts`
- `backend/src/types/session.ts`
- `frontend/src/api/client.ts`
- Phase 01 persistence and migration code
- Microsoft documentation referenced by each provider's owning prompt; verify permission/resource/role requirements before activating that adapter

## Required implementation

1. Define stable capability IDs for the retained scope, grouped by provider and permission set:
   - `graph.package.read.delegated`, `graph.package.read.application`, `graph.package.access.manage`, `graph.package.block.manage`, `graph.package.reassign.manage`, `graph.directory.read`;
   - `powerPlatform.inventory.read`, `powerPlatform.quarantine.manage`;
   - `purview.audit.search.delegated`, `purview.audit.search.application`;
   - `defender.hunting.delegated`, `defender.hunting.application`;
   - `reports.official.import`.
2. Define display name, purpose, provider/maturity, cloud, audience, mode, exact grants/provider roles, license/configuration, source links and data class. Provider definitions name a safe non-mutating probe where the actual API permits one; local-only definitions use local policy. Existing package routes use current read adapters; later integrations own their probes when delivered. Remote saved-query creation and mutation canaries are separate explicit qualifications, not routine probes.
3. Use incremental delegated consent. Initial login requests only OIDC identity and the minimum baseline required to render the shell. Add CSRF-bound consent routes that request one capability group and return safely to the application. Never request all privileged scopes at initial sign-in.
4. Acquire resource-specific delegated tokens for Microsoft Graph and Power Platform API only. Use Power Platform API app ID `8578e004-a5c6-46e7-913e-12f58912df43` and exact registered scope names. Environment/bot IDs used for quarantine do not imply a Dataverse integration.
5. Support Graph application tokens for explicitly requested package reads, audit searches and hunting when separately enabled by an administrator. Keep the supported MSAL client-secret setup: consume Phase 01's restricted mounted local files and the README's exact native Key Vault app-setting references on Azure. Keep database admin credentials out of the app. Never expose credentials to the browser or logs. Managed identity may access Azure resources but must not replace the Entra app's provider grants silently. No scheduled collectors or mandatory certificate/federation migration.
6. Use MSAL's in-memory cache and native acquisition APIs. Partition token selection by tenant, account, resource, scopes and delegated/application mode. Persist no access/refresh token, serialized MSAL cache or secret in sessions/database. Restart loses cached tokens: require reauthentication for delegated provider work and move affected durable jobs to `waiting_authorization`; never present token recovery as transparent. Define account-scoped logout/eviction and test isolation. No token-cache encryption/key-rotation subsystem is needed.
7. Define `AgentControl.Reader`, `AgentControl.Operator`, `AgentControl.SecurityReader` and `AgentControl.Administrator`; use Entra role claims and the README matrix. Own `infra/entra-app-manifest.json` for Phase 12. Development-only bootstrap is rejected in production; absent administrator assignment is diagnosed without auto-promotion. No role for deferred features.
8. Add `GET /api/capabilities` and CSRF-protected explicit probe refresh, with shared backend/frontend types. Return requirements, current decision/last success, freshness, preview qualification and remediation. Setup/probe routes require authentication, not the broken capability being repaired; they cannot target another account. Configuration requires `Administrator`. Register only retained integrations as their adapters are delivered; do not add future definitions or disabled placeholders. Local capabilities check local policy, not Microsoft probes.
9. Map current capability statuses exactly as defined in the README. Separate app grant, delegated consent, internal/provider role, license/configuration, preview and provider-error evidence. Do not infer a particular missing role from an ambiguous 403.
10. Token claims may prove a scope/app role is present but may not prove a service-side role or license. A successful non-mutating provider probe establishes availability. A 401/403 without a provider-specific diagnostic remains `unknown` or `provider_error`, with all plausible requirements shown; do not falsely assert one missing role.
11. Cache/serialize probes under the complete principal/resource/environment/token-mode/permission/configuration key from the README. Invalidate on consent/account/configuration/role changes; expire with a documented short TTL. Gates require current decision for provider actions, never another account's or stale successful probe. Cached-data reads require current internal/data-scope authorization but do not require a healthy live provider. Revalidate roles on a bounded session interval and support explicit session revocation; document the residual delay for external role revocation.
12. Give distinct preview operations separate capability IDs even when they share one permission. A read probe may prove token/catalog access but cannot prove a mutation endpoint. Implemented package access, block/unblock and quarantine management use `on_demand` probing with current Admin/provider authority and confirmation; never require prior canaries or extra mode/configuration. Optional canary evidence remains operation-specific and never gates ordinary writes. Owner reassignment has no implemented product workflow or documented owner readback; do not claim it works.
13. Enforce the README's role/data-scope matrix for private delegated versus explicitly shared application results. Stamp scope before persistence and filter before joins/counts/pagination/export. An exact identity match cannot widen visibility. Publish a small route-policy declaration/test helper; health, login/callback, shell and consent have explicit local policies.
14. Complete Phase 01's delegated job reauthorization contract: reacquire through the initiating account's MSAL cache, recheck actor/tenant/role/capability at execution and before each unsent item, and move to `waiting_authorization` on interaction-required, logout, or expired/revoked access. Only the same authorized principal can resume; expiration/cancellation has a finite deadline. App-only jobs use the explicitly configured application capability and never substitute for unavailable delegated credentials. Reconciliation of already-sent work is read-only and does not replay it.
15. Establish concise `docs/security-model.md` with role/data scope and the single-origin production trust boundary. Implement CSRF, state/nonce/PKCE, safe return URLs, secure sessions, trusted proxies, bounded requests and provider-origin/redirect/next-link checks. Never trust client-supplied identity headers. Protect credentials/tokens and render provider text inertly. Strengthen Phase 01's combined-app auth/origin behavior now; Phase 10 extends integrated static/browser proof and Phase 12 configures the exact Azure origin. Preserve the canonical local `localhost` URL across printed links, cookie and callback settings; its loopback bind address is not a second origin.
16. Own `docs/deployment-setup.md`: explain the two script workflows and guide administrators to prepare an existing RBAC-enabled Key Vault with exactly the six README secret names, value formats, enabled/expiry requirements and separate admin/app database passwords. Give secure portal/tool preparation steps without example real secrets. Cover the full vault resource ID, approved tenant/subscription, operator secret-read and ARM template-deployment permissions, runtime access to only the five non-admin secrets and actual network prerequisites. No vault creation/secret writing by `deploy-azure.ps1`, secret-value prompts or automatic broad access. Document local Entra reply URL and production registration/roles preparation; Phase 12 validates/applies only approved changes. Consume Phase 01's SQL/bootstrap contract rather than defining DB roles here.

## Exact permission contract

- Microsoft Graph package read: delegated or application `CopilotPackages.Read.All` (least privilege); `CopilotPackages.ReadWrite.All` is accepted but must not be requested for read-only operation.
- Microsoft Graph package writes: delegated `CopilotPackages.ReadWrite.All`.
- Microsoft Agent 365 licensing is required for Package Management API access. Current endpoint docs name no additional human Entra role; report that fact instead of guessing one.
- Directory lookup: delegated `User.ReadBasic.All` and `Group.Read.All`.
- Power Platform inventory: delegated `ResourceQuery.Resources.Read`; supported Entra roles are Global Administrator, Power Platform Administrator, Dynamics 365 Administrator, Global Reader, AI Administrator, or AI Reader, with AI roles limited to AI resources. Power Platform built-in RBAC roles do not grant inventory visibility.
- Copilot Studio quarantine: delegated `CopilotStudio.AdminActions.Invoke`; user must be Global Administrator, AI Administrator, or Power Platform Administrator.
- Purview Graph audit: delegated/application `AuditLogsQuery.Read.All` for cross-workload queries, subject to the Phase 07 live-contract probe; delegated users also need Purview Audit Logs or View-Only Audit Logs.
- Defender hunting: delegated/application `ThreatHunting.Read.All`; delegated data access is additionally constrained by Defender XDR RBAC/data-source assignment.

## Focused validation

- Unit-test registry completeness and uniqueness, feature-to-capability mapping, status precedence, remediation rendering data, and secret redaction.
- Test consent state/nonce/CSRF, callback failures, cache-loss reauthentication, app-role middleware, production bootstrap rejection and no-administrator diagnostics.
- Use Graph and Power Platform fixture tokens to prove resource, tenant, account, scope and delegated/application isolation; no tokens enter persisted sessions or database.
- Test delegated and application token acquisition with MSAL fixtures for consent required, invalid grant, missing app role, conditional access, tenant mismatch, and provider timeout.
- Require every privileged backend route to declare its app-role/data policy and, only for provider actions, the relevant capability. Local reports, saved data and setup routes declare explicit local policy without invented provider dependencies.
- Test principal A probe success versus principal B failure, separate environment/application scopes, consent/configuration invalidation, cached-read authorization during provider outage, private-to-shared scope denial, and no implicit administrator access to content.
- Test logout/cache isolation, delegated job restart/consent expiry/role revocation, application-mode substitution denial and resumption by the wrong principal.
- Test CSRF, open redirects, state replay, cross-tenant sessions, next-link/redirect SSRF, and setup/probe routes without a healthy provider. Write a source-linked provider contract inventory with checked date; missing live credentials remain unavailable evidence.
- Check setup-guide secret names against the README contract, local file consumers against Phase 01 and runtime settings against admin-secret exclusion. Test unconfigured local sign-in versus mandatory Azure auth configuration without enabling a bypass.

## Aggregate validation

Run the global validation baseline inside Phase 01's containers and verify login/callback configuration through `deploy-local.ps1`. Where credentials exist, perform non-mutating token/probe checks for configured audiences and record only status, tenant, audience, and correlation IDs.

## Production continuation

External identity/provider-probe unavailability is recorded with remediation, not fabricated success. A broken implemented core login/role boundary must be repaired before the phase is complete; only optional provider paths can remain disabled. Never broaden consent or assign a more privileged role just to make a probe pass.

## Scope guard

Do not implement provider data retrieval/mutations, deferred capabilities or recurring probes. Do not deploy to Azure or modify Entra yet; produce the manifest/configuration contract consumed by Phase 12.

## Completion record

Create `plans/admin-poc-production/completions/02-auth-capability-registry.md` with all required fields and a table of implemented capability IDs, exact requirements, probe status, and Phase 03 preconditions.

## Done conditions

- Authentication supports each required resource and token mode without over-requesting at login.
- Every privileged route enforces its backend app-role/data policy, with capability enforcement for provider actions and explicit local-only policies otherwise.
- Capability results are durable, refreshable, source-linked, and precise about uncertainty.
- Phase 03 can render feature state without recreating authorization logic.
- `docs/deployment-setup.md` gives the exact prepared-vault contract and local/Azure identity setup; Phase 12 can consume it without another credential design.
