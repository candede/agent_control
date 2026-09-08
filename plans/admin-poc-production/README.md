# Agent Control Admin POC Production Campaign

This ordered plan evolves the existing Graph package-management application into a small production inventory-and-controls workbench with official usage reporting, on-demand investigations and administrative history. It does not attempt to implement every capability from the original Microsoft research.

Application roots are `backend/`, `frontend/` and repository deployment assets. Inspect the affected producer, consumer, tests and configuration in each phase; do not redesign unaffected roots. This folder contains plans, not evidence that the application has been implemented or deployed.

## Product outcome

- Discover packages, Power Platform agents and Defender-discovered agents, retaining exact source identity and freshness.
- Import the three Microsoft 365 admin-center CSV exports as the only official usage authority.
- Run bounded, user-requested Purview audit searches and curated Defender/Agent 365 hunting queries.
- Inspect and operate qualified package controls and Copilot Studio quarantine with exact targets, confirmation, audit and verification.
- Explain current permission, role, license, configuration and preview limitations; show authorized saved results honestly when stale.
- Export permitted inventory, report and investigation fields without presenting one source as another source's authority.

## Explicit scope boundary

This is a single-Entra-tenant POC, not a SIEM, workflow platform or replacement for Microsoft portals. Use Express, React, MSAL, PostgreSQL and Azure App Service. No generic plugin/database framework, separate queue/cache service, arbitrary KQL editor or speculative provider modes.

Do not implement Dataverse transcripts in any form, including live viewing, storage, analytics or exports. Do not implement the Management Activity feed, subscriptions, scheduled inventory/hunting collection, manual identity merge/link workflows, raw response or original CSV archives, custom audit cryptography, content encryption infrastructure, interactive maintenance consoles, split hosting, deployment slots or mandatory certificate migration. There are no dormant adapters, grants, tables, feature flags or disabled UI placeholders for removed features.

[FUTURE-IDEAS.md](FUTURE-IDEAS.md) is a non-executable parking lot. Its contents require a separate future scope decision and are not prerequisites, optional tasks or acceptance criteria for this campaign. Ordinary authentication security, managed storage protection, audit access control, retention and backups remain required.

## Binding architecture

1. **Backend capability authority.** Definitions describe exact endpoint/maturity, resource audience, token mode, API permissions, provider roles, license/configuration and probe evidence. Authorize each route and data class server-side; the UI consumes that decision.
2. **Availability is not authorization.** Scope evidence to tenant, principal/application identity, resource, token mode, permission/configuration revision and tested contract. Never reuse another principal's probe. Statuses are `available`, `missing_permission`, `missing_internal_role`, `missing_role`, `missing_license`, `not_configured`, `unsupported`, `preview_disabled`, `provider_error` and `unknown`. Keep implementation/activation, staleness, last success and write qualification separate. Ambiguous provider errors must not invent a particular missing role or license.
3. **Separate source authority.** Package catalog, Power Platform, official CSV reports, Purview and Defender keep source-native IDs, scope, observed time and coverage. Exact documented identifier-kind/value matches within tenant/environment may associate records. Names, owners and timestamps are never identity keys. Unmatched records stay separately usable; an association cannot broaden visibility or redirect a mutation.
4. **Minimal retained data.** Store validated report rows, allowlisted provider fields, bounded job/results metadata and ordinary administrative audit. Discard original uploads and provider responses after validation. No universal raw JSON warehouse, immutable replay system or event-derived official usage.
5. **On-demand work only.** Provider refresh, import, search and mutation start from explicit authorized actions. Bounded in-process execution and polling may complete those durable jobs; restarting must not create recurring collection. Saved records show their last observation and scope. Ordinary expiry/retention cleanup may run without becoming a provider scheduler.
6. **Durable backend, ephemeral tokens.** PostgreSQL owns sessions, jobs, results and audit. Use MSAL's native in-memory cache; never persist tokens or cache blobs in sessions/database. Restart requires delegated reauthentication and `waiting_authorization` jobs. Protect existing supported app credentials through Key Vault settings; managed identity may simplify Azure access but does not substitute for provider grants. No mandatory credential migration or custom token encryption service.
7. **Verified mutations.** Persist exact target and intent before sending, audit attempts/outcomes, confirm risk, and read after write. An ambiguous remote outcome is `inconclusive`, not success or an automatic retry. Job leases prevent stale result commits, not duplicate external effects. Reauthorize unsent work and require explicit reconciliation/new approval where needed.
8. **Least privilege and preview visibility.** Request delegated consent by capability, not all grants at login. Application access is separately enabled for explicitly requested Graph reads/investigations with administrator-approved data scope, never unattended collectors. Preview writes are independently qualified and can remain disabled while stable reads work.
9. **One database from Phase 01.** PostgreSQL is the sole new runtime authority locally and in production. Each feature owns its additive migrations, scoped queries and retention. Preserve legacy SQLite audit through a tested standalone one-time importer, executed only in Phase 12 against a verified production backup. Existing deployment stays untouched until release; old in-memory jobs/sessions are not recoverable from SQLite.
10. **Direct cutovers.** Remove a replaced runtime authority in the same owning phase: no dual writes, aliases, compatibility branches or automatic database resets. Separate sources may coexist because they answer different questions, not as fallback authorities.
11. **One origin and artifact, two deployment entry points.** Phase 01 owns combined Express/React serving, a multi-stage Docker build and `deploy-local.ps1`; Phase 10 extends/tests that existing package without introducing another runtime. Locally, Compose runs exactly two long-running services: `app` and `postgres`. Phase 12 owns `deploy-azure.ps1`, one App Service instance and Azure Database for PostgreSQL Flexible Server, plus retirement of the old Static Web Apps dependency and old deployment entry point. Azure is PaaS-only: no customer-managed VM, database container, slots, mirrored cloud stack, HA or autoscale.

## Deployment contract

These are implementation requirements, not scripts already delivered by this plan review. There are exactly two supported root deployment entry points: `deploy-local.ps1` and `deploy-azure.ps1`. Shared helpers are allowed; a third deployment wizard or a compatibility wrapper for the old entry point is not.

### Local: all application components in Docker

- `pwsh ./deploy-local.ps1` checks PowerShell 7, a running Docker engine and Compose v2; builds the app, starts PostgreSQL, performs bounded database bootstrap/migrations in a disposable container, then starts the app and reports its healthy URL. Docker/Desktop installation and OS privilege approval remain operator prerequisites, never hidden installation steps.
- The two persistent services are `app` (Express API, built React assets and bounded user jobs) and `postgres` (one pinned supported major with a named data volume). No host Node.js, npm, Vite or PostgreSQL process is needed. Build/test/migration containers are temporary, not additional always-running services. PowerShell, Docker CLI and the browser are host tools, not application services.
- Bind the app to `127.0.0.1:3001` by default, with an explicit configurable host port and matching origin/callback; listen on all interfaces inside the container. Print/open `http://localhost:3001` as the canonical browser origin, not a second `127.0.0.1` origin. PostgreSQL is reachable only on the project-scoped bridge network and has no published host port; preserve app outbound HTTPS/DNS for Entra/providers rather than an egress-blocked `internal: true` network. Use `http://localhost:3001/api/auth/callback` as the default explicitly registered local Entra reply URL. No separate frontend origin or Vite server in this deployment.
- The script creates/reuses project-scoped networks, volumes and local-only generated DB/session secrets. Prompt securely for the Entra client secret or accept an existing ignored secret file; collect tenant/client IDs as non-secret values. Mount ignored restricted secret files at runtime, never bake them into images, build arguments or logs. Missing identity setup yields a healthy but sign-in-unconfigured app with exact setup guidance, not an auth bypass. Phase 02 extends this configuration for capabilities.
- Repeated runs preserve data and secret files; do not silently rotate database credentials, reset imports or delete volumes. Missing/corrupt DB secrets with existing data stop for operator recovery. Stop/restart and explicit destructive reset are documented separately with exact target confirmation. Build, tests, migrations, backups and browser automation run in Docker; no host application toolchain is required.

### Azure: managed, budget-conscious deployment

The selected topology is one Linux App Service for the built React frontend and Express backend together, plus one Azure Database for PostgreSQL Flexible Server for persistent application data. The App Service uses one App Service Plan for its compute; that plan is not a separate frontend/backend application or a customer-managed VM. Reuse the administrator-prepared Key Vault. Microsoft operates the database host, OS, storage and routine service patching; the customer configures database access, schema and capacity, not a VM. Managed-service/network approval may still be required by customer policy. Azure Container Apps, database sidecars and Azure Files/NFS are not part of this selected deployment.

- `pwsh ./deploy-azure.ps1` is an interactive non-secret wizard with equivalent explicit parameters for repeat runs. It collects/validates subscription, resource group, region, resource names, **existing Key Vault resource ID**, canonical origin, maintenance approval and budget. Host prerequisites are PowerShell 7, Docker and Azure CLI/Bicep; build/test/migration tools run in containers. Interactive Azure login is allowed; no secret values are requested in the wizard.
- The app uses one Linux App Service instance, initially Basic B1 where available and adequate. Export one Linux deployment ZIP from the same Docker build used locally and deploy it to App Service's built-in Node runtime. No separate frontend, custom-image registry or VM is needed. Pin the Azure-target build architecture/runtime; a Mac ARM image must not supply incompatible native dependencies to the Azure artifact.
- Use **Azure Database for PostgreSQL Flexible Server, Burstable B1ms**, initially 32 GiB storage, seven-day backup retention, one region, HA and replicas disabled, and a small bounded pool. Verify current regional support/capacity before selection; never silently upgrade to a costly tier. This is a publicly hosted POC, not a continuously available enterprise production service. Burstable CPU-credit and support limits must be shown honestly.
- App restart/replacement/redeployment and managed database restart must preserve committed application data. Release reuses the approved server/database and applies forward migrations; it never drops/recreates storage or silently initializes an empty replacement when an expected target is missing or unreachable. Phase 12 owns target-reuse guards; Phase 13 proves persistence with bounded maintenance-window checks. Planned retention/approved migrations remain explicit, and lost in-memory MSAL tokens still require reauthentication. Backups support recovery from separate failures; restoring a backup is not the normal redeployment path.
- Show an itemized region/currency/date-specific estimate for App Service, database compute/storage/backup, monitoring, Key Vault and any required networking before paid changes. If automatic pricing lookup is unavailable, require a recorded current calculator estimate and explicit budget approval; never invent a quote or claim deployment is free. Reuse suitable approved resources. Cap telemetry retention/ingestion and alert on budget/storage/CPU-credit thresholds; a budget alert is not a hard spending cap. No VM, managed disk for self-hosted PostgreSQL, AKS, Redis, extra worker or mandatory private endpoint unless tenant policy actually requires it.
- PostgreSQL is the only selected database, locally and in Azure. Cosmos DB is not a drop-in cheaper PostgreSQL tier: changing query, partition and transaction contracts adds implementation cost. Its free tier requires eligibility and explicit account creation choices, and is not available for serverless accounts. Do not implement dual persistence or a Cosmos wizard option in this campaign. A cost-driven redesign needs a separate approved decision; record that option in the future-only document.
- Phase 12 replaces `deploy-production.ps1` with `deploy-azure.ps1` and updates callers/docs in the same change, without an alias. Earlier phases may read the existing script as migration context but must not run it for cloud deployment. The Azure wizard deploys only to its approved target and never installs PostgreSQL in a VM or app container.

### Administrator-prepared Key Vault

Phase 02 owns `docs/deployment-setup.md`, which tells the administrator to prepare an existing RBAC-enabled vault and populate these **secret names** (not Azure resource tags or secret attributes) before the Azure wizard runs. Identity IDs are non-secret values stored there for one setup source; no provider access/refresh tokens belong in the vault.

| Exact secret name                       | Value supplied by administrator                                                      | Consumer                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `agent-control-tenant-id`               | Entra tenant GUID, matching the approved tenant                                      | Wizard validation and app `TENANT_ID`                                                 |
| `agent-control-client-id`               | Existing Entra application/client GUID                                               | Wizard validation and app `CLIENT_ID`                                                 |
| `agent-control-client-secret`           | Valid client secret for that application                                             | App `CLIENT_SECRET` only                                                              |
| `agent-control-session-secret`          | Independently generated high-entropy value, at least 32 random bytes encoded as text | App `SESSION_SECRET` only                                                             |
| `agent-control-postgres-admin-password` | Strong PostgreSQL-compatible password for the planned `agentcontrol_admin` login     | Provisioning and operator-only migration/bootstrap/maintenance, never the running app |
| `agent-control-postgres-app-password`   | Different strong password for restricted `agentcontrol_app` login                    | Bootstrap plus app `PGPASSWORD`                                                       |

Database `agentcontrol` and the two login names above are fixed non-secret defaults; server host/port are derived from deployment outputs. Construct driver settings structurally; do not concatenate secrets into an unescaped connection URL. The runtime role cannot perform migrations or modify/delete audit history; operator-only maintenance uses the elevated role.

The wizard accepts the full ARM vault ID `/subscriptions/<id>/resourceGroups/<group>/providers/Microsoft.KeyVault/vaults/<name>`, resolves the vault URI and checks approved tenant/subscription scope, RBAC, network reachability, named-secret presence/enabled/expiry state and non-empty values without printing values. It lists missing names and links setup instructions, then lets the administrator fix the vault externally and recheck. It never creates the vault, sets secret values, rotates credentials or weakens its firewall/access policy. Merely entering a vault ID is not proof of access.

Select consistent secret versions for provisioning/bootstrap and versioned app references; retain only their non-secret references in the release receipt. Reruns verify existing credentials/grants. Changed prepared credentials require the separately approved coordinated administrator rotation runbook from Phase 11 before release, not automatic password replacement by the wizard.

Use native [Key Vault deployment references](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/key-vault-parameter) for the database admin password in secure Bicep module parameters. The administrator must enable template deployment access and grant the deployment identity the required vault deployment action plus narrowly scoped read access for validation/bootstrap. Check the actual ARM, operator runner and App Service access paths separately. App Service uses managed identity and native Key Vault references only for its five runtime values (all rows except admin password); grant secret-read access scoped to those secrets, not the admin secret. Preview and obtain approval for required identity role assignments, or verify an administrator-created assignment. Runtime credentials/DB grants are verified before reopening. The script never stores values in command arguments, receipts, ARM outputs, checked-in files or image layers; any necessary bootstrap secret transport is short-lived, restricted and cleaned on failure.

## Ownership

| Contract                                                                                                   | Implementation owner | Consumer / proof owner                                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| PostgreSQL, sessions/jobs/audit, legacy importer, maintenance, Docker package/Compose and deploy-local.ps1 | 01                   | All phases use container execution; integrated package/UI 10; security 11; Azure release 12 |
| Auth, four roles, data scope, capabilities, credentials, Entra manifest and Key Vault setup guide          | 02                   | All routes/providers; UI 03; security 11; vault wizard/references 12; live 13               |
| Shared UI capability gates and component/browser/accessibility harness                                     | 03                   | Feature UIs; workbench 10; live 13                                                          |
| Manual Power Platform inventory, exact IDs, allowlisted snapshots and scan coverage                        | 04                   | Package/report/investigation associations; workbench 10                                     |
| Package controls, uncertain-write reconciliation, canary/recovery specification                            | 05                   | Quarantine 09; security 11; live canaries 13                                                |
| Official report validation, staging, versions and active set                                               | 06                   | Reporting/exports 10; live 13                                                               |
| On-demand Purview query lifecycle and scoped audit records                                                 | 07                   | Two-source audit view 10; live 13                                                           |
| Curated on-demand hunting and proven source scope                                                          | 08                   | Workbench 10; live 13                                                                       |
| Direct Copilot Studio quarantine semantics and restoration                                                 | 09                   | Workbench 10; live 13                                                                       |
| Integrated UI/exports and regression proof of Phase 01 container/package/static routing                    | 10                   | Security/capacity 11; Azure release 12; live browser 13                                     |
| Security review, ordinary retention, backups/recovery commands and operating limits                        | 11                   | Cloud recovery/release 12; operations handoff 13                                            |
| deploy-azure.ps1 wizard, prepared-vault preflight, cost-approved managed resources, backup/import/release  | 12                   | Exact-revision production observation and fix-forward 13                                    |
| Live retained-feature qualification, canaries/restoration and operational handoff                          | 13                   | Campaign completion                                                                         |

Owners record concrete module/type/migration/test/runbook paths. Consumers reuse those artifacts instead of inventing another abstraction. A new schema owner proves fresh creation, upgrade from the previous schema, retry/failure behavior and ordinary retention. Phase 11 verifies earlier controls; it is not their first implementation owner.

## Permissions and data access

An Entra API permission on the registered app, a provider role on a human, an internal app role, and a license are distinct. Consent does not grant provider roles. Validate current Microsoft documentation during each integration phase; do not broaden grants to hide uncertain provider behavior.

| Capability                 | Registered-app permission                                                                                       | Token mode and additional requirements                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package catalog read       | Graph `CopilotPackages.Read.All`                                                                                | Delegated/application; Agent 365 license. Do not invent an additional human role absent from endpoint documentation.                                                                                                                                           |
| Package controls           | Graph `CopilotPackages.ReadWrite.All`                                                                           | Delegated only; Agent 365 license; preview/global-cloud constraints and separate live write qualification.                                                                                                                                                     |
| Directory lookup           | Graph `User.ReadBasic.All`, `Group.Read.All`                                                                    | Delegated; appropriate tenant consent.                                                                                                                                                                                                                         |
| Power Platform inventory   | `ResourceQuery.Resources.Read`, API app ID `8578e004-a5c6-46e7-913e-12f58912df43`                               | Delegated only in this POC. Global Administrator, Power Platform Administrator, Dynamics 365 Administrator or Global Reader sees all inventory; AI Administrator/Reader sees AI-scoped resources. Built-in Power Platform RBAC is not an inventory substitute. |
| Copilot Studio quarantine  | Power Platform `CopilotStudio.AdminActions.Invoke`                                                              | Delegated; Global Administrator, AI Administrator or Power Platform Administrator. Classic bots unsupported.                                                                                                                                                   |
| Purview Audit Search       | Graph `AuditLogsQuery.Read.All`, or a documented narrower query permission proven to cover the required records | Delegated/application; audit enabled; delegated Audit Logs or View-Only Audit Logs role; licensing controls retention/bandwidth.                                                                                                                               |
| Defender/Agent 365 hunting | Graph `ThreatHunting.Read.All`                                                                                  | Delegated/application; Defender XDR and applicable Agent 365/service licensing. Delegated hunting also obeys Defender data-source/RBAC scope.                                                                                                                  |
| Official CSV import        | No added Microsoft API permission                                                                               | Local administrator import; separate result-read roles below.                                                                                                                                                                                                  |

Graph Audit Search references have documented inconsistencies: create/list-records pages use `AuditLogsQuery-*`, a single-query GET page lists `ThreatIntelligence.Read.All`, and resource pages differ on `serviceFilter`/`serviceFilters`. Phase 07 proves the live contract without silently adding unrelated permissions.

Internal roles are additive, with no hierarchy. Any recognized role can open the shell and its own Permission Center; `Administrator` alone is not an operator or security reader.

| App role                      | Authorized data/actions                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `AgentControl.Reader`         | Inventory and aggregate official usage                                                                   |
| `AgentControl.Operator`       | Minimal exact-target control reads and package/quarantine operations                                     |
| `AgentControl.SecurityReader` | Local/provider audit, hunting results and user-level official usage                                      |
| `AgentControl.Administrator`  | Configuration, report import/validation preview, operational metadata; not general investigation results |

Import preview is limited to the administrator's submitted data and validation task; reading published reports follows their data-class role. Export authorization equals source-read authorization. Submission authority never implicitly grants access to unrelated sensitive job results.

Delegated saved results are private to their initiating principal by default. Shared application-mode datasets require explicit administrator-approved scope and the reader role for that class; read-only application work is still manually requested. Official report imports are explicitly tenant-shared with aggregate/user-level separation. Scope every row/request to the configured tenant and reject mismatches. Filter before joins, counts, pagination, result retrieval and exports; a cross-source association never bypasses filtering. Recheck current role/data scope when accessing stored results, not just at submission. Provider unavailability does not erase authorized saved data.

Each owner supplies finite retention and deletes dependent projections and expired exports with the source. Managed backups have a documented finite lifetime; restoration requires an operator review and cleanup before service reopens. No legal-hold engine, external deletion ledger or promise of instant deletion from every backup is in scope.

Availability describes the tested provider contract, coverage the resources/time window actually observed, and freshness the age of evidence. Empty results can be successful; partial or stale results must not imply current complete coverage.

## Ordered implementation manifest

Execute one prompt per fresh session in this exact order. Verify the predecessor's completion against the current worktree and its evidence before starting the next prompt.

1. [01 - Domain and persistence foundations](01-domain-persistence-foundations.md)
2. [02 - Authentication and capability registry](02-auth-capability-registry.md)
3. [03 - Permission Center and feature gating](03-permission-center-ui.md)
4. [04 - Power Platform inventory and exact identities](04-power-platform-inventory.md)
5. [05 - Package controls and reassignment](05-package-management.md)
6. [06 - Official usage-report ingestion](06-official-usage-ingestion.md)
7. [07 - On-demand Graph Purview Audit Search](07-graph-audit-search.md)
8. [08 - On-demand Defender and Agent 365 hunting](08-defender-agent365-hunting.md)
9. [09 - Copilot Studio quarantine](09-copilot-studio-quarantine.md)
10. [10 - Unified workbench and single-app delivery](10-unified-admin-workbench.md)
11. [11 - Security and basic operations](11-security-operations.md)
12. [12 - Production deployment](12-production-deployment.md)
13. [13 - Live qualification and hardening](13-live-qualification.md)

## Manual fresh-session execution

This review authorizes plan edits only, not application implementation, provider consent, cloud provisioning or deployment now. During later execution, Phase 01 and its consumers may deploy locally with `deploy-local.ps1`; only Phases 12 and 13 may deploy to Azure with `deploy-azure.ps1` and the exact approved target recorded in Phase 12. In these prompts, "do not deploy" before Phase 12 means no cloud deployment, not a prohibition on required local container runs. Earlier live tests use explicitly approved bounded provider test resources, never arbitrary tenant assets.

```text
Implement only plans/admin-poc-production/<numbered-phase>.md.
Read plans/admin-poc-production/README.md, this phase's prerequisites and their
completion records. Verify the relevant delivered artifacts in the worktree.
Implement, validate, and write this phase's completion record. Stop at this
phase; do not run the next prompt. Preserve unrelated changes. Local deployment
and tests use Phase 01's Docker contract. Do not commit, push, deploy to Azure
or change provider grants unless this phase and its approved target explicitly
permit that action. FUTURE-IDEAS.md is not implementation scope.
```

No orchestrator, subagent, hidden chat history or separate campaign ledger is required. Read the immediate predecessor and earlier contract owners named by the prompt, using their actual artifact paths. Read-first anchors are navigation aids, not an instruction to reread the whole repository. Repair and attribute a missing prerequisite before activating its consumer. A fresh session never resets persistence or repeats production imports automatically.

## Completion records

Each phase owns exactly one record with its prompt's basename under `plans/admin-poc-production/completions/`. Workers create that directory. Use [COMPLETION_TEMPLATE.md](COMPLETION_TEMPLATE.md); support documents and records are not executable phases.

Record delivered behavior/contracts, changed files, migrations/cutovers, permissions, actual validation commands/results, relevant live target without secrets, linked open issues and exact next action. Evidence statuses are `passed`, `failed`, `not_run`, `unavailable` and `inconclusive`. State `phase_status: in_progress` or `complete`; a complete phase may have outcome `completed`, `completed_with_disabled_capabilities` or `completed_with_residuals`. `deployment_pending` remains `in_progress` and is not a successful outcome.

For each new residual, record affected scope, evidence, containment, telemetry/canary and threshold, owner and exact fix-forward trigger once in its origin record. Later records link unresolved issues and record any changed status or closure proof; do not copy all history. A current-worktree impact check replaces per-file/prompt hashing and repeated bookkeeping. Release artifact revision/checksum evidence remains required in Phases 12/13. Missing implementation, broken required artifacts or unaddressed reproducible core defects cannot masquerade as a completed disabled provider. Interrupted sessions leave an exact same-phase resume instruction; only complete phases advance.

## Production completion contract

The full sequence ends with authorized production deployment, observation of the exact deployed artifact and fix-forward handling, not an undeployed readiness report. Each manual session still stops at its phase boundary.

- Phase 12 verifies operator approval for exact tenant, subscription, resource group, region, app registration, resource IDs, canonical origin, maintenance window and cost ceiling before remote changes. CLI login alone is not approval.
- Attempt all required local, database, browser, restore, capacity and provider checks; preserve their real results and repair reproducible defects. Missing optional provider access can leave that retained capability truthfully disabled, not justify speculative grants or fake success.
- Non-passing preproduction evidence alone does not veto deployment. Bound affected features through capability controls and carry an actionable residual while deploying safe paths. Do not expose unsafe writes, broken authentication or corrupt data. A failed core safety check keeps release work open for repair; it never authorizes a destructive migration or a false successful deployment.
- Use a maintenance window on the single app: stop admissions, drain or reconcile jobs, back up and verify, migrate/import, deploy the one artifact, smoke-test and reopen healthy core paths. No closed-slot or blue/green release requirement. Retain a verified prior artifact for schema-compatible recovery; after incompatible changes use forward repair or the documented approved restore, never revive the old authority against the new database.
- Production qualification uses dedicated approved canary objects/accounts and isolated test datasets where needed, not a general synthetic-data platform. Use read-only checks first; remote search creation and reversible mutations need explicit bounded approval. Restore canary state and remove temporary resources; cleanup failures remain owned cost/security incidents.
- Production feedback drives containment, root fix, focused validation, redeployment and repeated canary checks. Only literal inability to execute approved production control-plane actions may be `deployment_pending`; record the missing action/identity and exact resume step and leave the campaign open. Core defects remain in-progress repair, not deployment-pending paperwork.

## Global validation baseline

Every phase runs focused checks plus applicable aggregate commands. The following npm commands run inside Phase 01's Docker build/test targets, never directly on the host:

```bash
npm run test --workspace backend
npm run test --workspace frontend
npm run typecheck --workspace backend
npm run lint --workspace frontend
npm run build
```

Phase 01 supplies the exact Compose invocations, isolated test database, start/migrate/backup/restore and packaged-app smoke commands; run `git diff --check` and host PowerShell checks on the host. Phase 03 adds containerized component/browser/accessibility tooling, Phase 10 extends package/UI smoke, and Phase 11 adds bounded security/load/recovery checks. Temporary test containers exit/clean up and do not change the two-service local runtime. Each owner records exact invocations and prerequisites; missing scripts are work for that owner. Use deterministic provider fixtures; live calls never run implicitly in ordinary tests.

Keep credentials, tokens and sensitive report/audit contents out of logs, fixtures, screenshots and completion records. Commercial/global cloud is the initial target; do not build unproved alternate-cloud routing. Provider contract uncertainties retain explicit evidence and feature containment.

## Review notes

[REVIEW.md](REVIEW.md) records the current simplification decisions and documentation-only verification limits. It is not an implementation completion record.
