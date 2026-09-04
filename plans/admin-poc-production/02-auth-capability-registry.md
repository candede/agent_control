# Phase 02 - Multi-Resource Authentication and Capability Registry

## Mission

Replace the single hard-coded Graph consent bundle with backend-owned multi-resource authentication, internal application RBAC, and a capability registry that states and probes exact Microsoft permissions, roles, licensing, configuration, cloud, and API maturity.

## Prerequisites

- Read the roadmap and `completions/01-domain-persistence-foundations.md`.
- Phase 01 migrations, durable sessions, jobs, provider configuration, and capability repositories must exist.
- Do not deploy in this phase.

## Read first

- `backend/src/config.ts`
- `backend/src/auth/msal.ts`
- `backend/src/routes/auth.ts`
- `backend/src/middleware/auth.ts`
- `backend/src/types/session.ts`
- `frontend/src/api/client.ts`
- Phase 01 persistence and migration code
- Microsoft references linked from the roadmap permission matrix

## Required implementation

1. Define stable capability IDs grouped by provider and permission set. Include at least:
   - `graph.package.read.delegated`, `graph.package.read.application`, `graph.package.access.manage`, `graph.package.block.manage`, `graph.package.reassign.manage`, `graph.directory.read`;
   - `powerPlatform.inventory.read`, `powerPlatform.quarantine.manage`;
   - `purview.audit.search.delegated`, `purview.audit.search.application`;
   - `managementActivity.ingest.application`;
   - `defender.hunting.delegated`, `defender.hunting.application`;
   - `dataverse.transcripts.delegated`, `dataverse.transcripts.application`;
   - `reports.official.import`.
2. For each capability define display name, purpose, features unlocked, provider, stable/preview state, cloud availability, resource audience, token mode, exact delegated/application permissions, exact user/environment roles, license prerequisites, configuration prerequisites, source links, privacy classification, and non-mutating probe.
3. Use incremental delegated consent. Initial login requests only OIDC identity and the minimum baseline required to render the shell. Add CSRF-bound consent routes that request one capability group and return safely to the application. Never request all privileged scopes at initial sign-in.
4. Support resource-specific delegated token acquisition for Microsoft Graph, Power Platform API, and configured Dataverse environment URLs. Use Power Platform API app ID `8578e004-a5c6-46e7-913e-12f58912df43` and scope names exactly as registered.
5. Support client-credential token acquisition for Graph and Office 365 Management APIs, and for Dataverse environment audiences. Prefer certificate or managed-identity credentials in production; retain client-secret support only for the existing deployment until Phase 14 performs the infrastructure cutover.
6. Persist the MSAL token cache encrypted at rest through a Key Vault-backed key reference or an authenticated-encryption key supplied via a Key Vault app setting. Never store tokens in ordinary provider configuration rows or logs.
7. Define internal app roles `AgentControl.Reader`, `AgentControl.Operator`, `AgentControl.SecurityReader`, `AgentControl.TranscriptReader`, and `AgentControl.Administrator`. Enforce them server-side from Entra role claims. Make `infra/entra-app-manifest.json` the canonical no-secret role/permission manifest consumed by Phase 14. A configured bootstrap administrator is permitted only when `NODE_ENV=development`; production rejects that setting and never auto-promotes a user. If no production administrator is assigned, protected administration remains denied and diagnostics identify the manual Entra app-role assignment recovery path.
8. Add `GET /api/capabilities` and a targeted refresh endpoint. Return grouped capability status, requirements, probe evidence, freshness, unlocked features, remediation steps, and current principal role status. Never return tokens or secrets.
9. Implement status precedence and provider-error mapping. Distinguish missing app grant, missing delegated consent, missing internal app role, missing Microsoft admin role, missing Dataverse environment role, missing license/rollout, not configured, unsupported cloud, preview disabled, throttled/provider failure, and unknown.
10. Token claims may prove a scope/app role is present but may not prove a service-side role or license. A successful non-mutating provider probe establishes availability. A 401/403 without a provider-specific diagnostic remains `unknown` or `provider_error`, with all plausible requirements shown; do not falsely assert one missing role.
11. Cache probes with short TTLs, support manual refresh, serialize duplicate probes, enforce timeouts and retries, and retain the last successful result alongside current failure without presenting stale success as current availability. Return current status/evidence/observed time separately from last-success status/evidence/observed time and an explicit `stale` flag. Gates consume current status; read-only cached data may cite last success as historical evidence.
12. Give independently disableable preview operations separate capability IDs even when they share one permission. A read probe may prove token/catalog access but cannot prove a mutation endpoint. Package access, block/unblock, and reassign retain separate contract/canary evidence so removal of one endpoint does not disable or falsely qualify the others.

## Exact permission contract

- Microsoft Graph package read: delegated or application `CopilotPackages.Read.All` (least privilege); `CopilotPackages.ReadWrite.All` is accepted but must not be requested for read-only operation.
- Microsoft Graph package writes: delegated `CopilotPackages.ReadWrite.All`.
- Microsoft Agent 365 licensing is required for Package Management API access. Current endpoint docs name no additional human Entra role; report that fact instead of guessing one.
- Directory lookup: delegated `User.ReadBasic.All` and `Group.Read.All`.
- Power Platform inventory: delegated `ResourceQuery.Resources.Read`; supported Entra roles are Global Administrator, Power Platform Administrator, Dynamics 365 Administrator, Global Reader, AI Administrator, or AI Reader, with AI roles limited to AI resources. Power Platform built-in RBAC roles do not grant inventory visibility.
- Copilot Studio quarantine: delegated `CopilotStudio.AdminActions.Invoke`; user must be Global Administrator, AI Administrator, or Power Platform Administrator.
- Purview Graph audit: delegated/application `AuditLogsQuery.Read.All` for cross-workload queries, subject to the Phase 07 live-contract probe; delegated users also need Purview Audit Logs or View-Only Audit Logs.
- Management Activity: Office 365 Management APIs application `ActivityFeed.Read`; unified audit logging must be enabled.
- Defender hunting: delegated/application `ThreatHunting.Read.All`; delegated data access is additionally constrained by Defender XDR RBAC/data-source assignment.
- Dataverse delegated: the environment resource's delegated `user_impersonation`; user needs Bot Transcript Viewer in that environment.
- Dataverse application: no broad Entra application permission substitutes for an application user. Create an application user per environment and assign a custom read-only ConversationTranscript role.

## Focused validation

- Unit-test registry completeness and uniqueness, feature-to-capability mapping, status precedence, remediation rendering data, and secret redaction.
- Test incremental consent state/nonce/CSRF, callback failures, expired account recovery, encrypted cache restart, app-role middleware, bootstrap rejection in production, and no-administrator diagnostics.
- Acquire fixture tokens for Graph, Power Platform, and two distinct Dataverse environment audiences; prove cache keys cannot substitute a token across resources, tenants, accounts, delegated/application modes, or Dataverse hosts.
- Test delegated and application token acquisition with MSAL fixtures for consent required, invalid grant, missing app role, conditional access, tenant mismatch, and provider timeout.
- Add a contract test requiring every privileged backend route to declare both an internal app role and a capability ID.

## Aggregate validation

Run the global validation baseline. Where credentials exist, perform non-mutating token/probe checks for configured audiences and record only status, tenant, audience, and correlation IDs.

## Production continuation

Auth or provider-probe failures do not stop later implementation. Keep only the affected capability disabled, preserve exact remediation and telemetry, and carry the truthful result. Never broaden consent or assign a more privileged role just to make a probe pass.

## Scope guard

Do not implement provider data ingestion or mutations. Do not expose transcript content. Do not deploy or modify the Entra app registration yet; produce the checked-in manifest/config contract consumed by Phase 14.

## Completion record

Create `plans/admin-poc-production/completions/02-auth-capability-registry.md` with all required fields and a table of implemented capability IDs, exact requirements, probe status, and Phase 03 preconditions.

## Done conditions

- Authentication supports each required resource and token mode without over-requesting at login.
- Every privileged route has backend app-role and capability enforcement.
- Capability results are durable, refreshable, source-linked, and precise about uncertainty.
- Phase 03 can render feature state without recreating authorization logic.
