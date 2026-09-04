# Agent Control Admin POC Production Campaign

This folder is an ordered, self-contained implementation campaign for evolving Agent Control from a Microsoft Graph package-management tool into a production-deployed admin POC that demonstrates every Microsoft-supported agent inventory, usage, audit, security, quarantine, and transcript capability identified during the September 4, 2026 research pass.

The application roots are the repository-level deployment assets, `backend/`, and `frontend/`. Every phase must inspect all three roots for affected producers, consumers, permissions, tests, documentation, and deployment configuration.

## Product outcome

The completed application must give an administrator one place to:

- discover and distinguish Microsoft 365 Copilot packages, Copilot Studio and Agent Builder agents, and Agent 365/Defender-discovered agents;
- preserve Microsoft 365 admin-center CSV imports as the authoritative source for official per-agent and per-user usage metrics until Microsoft publishes a supported agent-report API;
- search Microsoft Purview audit records on demand and optionally ingest the Office 365 Management Activity feed continuously;
- query Agent 365/Defender inventory and observability data where the tenant is licensed and connected;
- inspect and operate Microsoft 365 package controls, including preview access/block/reassign operations with explicit verification;
- inspect and operate Copilot Studio quarantine controls;
- ingest Copilot Studio Dataverse conversation transcripts under explicit privacy, environment, role, and retention controls;
- explain every enabled, disabled, degraded, preview, missing-permission, missing-role, missing-license, and missing-configuration state in the UI;
- export normalized inventory, official usage, audit, security, and transcript-derived views without presenting one source as another source's authority.

## Binding architecture

1. **Capability registry is the UI authority.** Backend-owned capability definitions state the exact API, API maturity, token mode, resource audience, Entra delegated/application permissions, user or environment roles, licenses, configuration, and runtime probe for each feature. The frontend renders those results and never guesses authorization from a failed button click.
2. **Runtime probes are authoritative for availability.** Token claims and configured grants are evidence, not proof that a tenant role, service license, environment role, or provider rollout is effective. Each integration has a non-mutating probe and records `available`, `missing_permission`, `missing_role`, `missing_license`, `not_configured`, `unsupported`, `preview_disabled`, `provider_error`, or `unknown` with remediation.
3. **Sources retain separate authority.** Package catalog, Power Platform inventory, Microsoft 365 usage exports, Purview audit, Management Activity, Defender hunting, and Dataverse transcripts remain separately identifiable observations. Normalized projections carry source, source ID, observed time, raw revision/checkpoint, freshness, and confidence. Names are never identity keys.
4. **Official usage remains explicit.** Only the Microsoft Copilot Agents usage report imports may be labeled official usage. Audit-event counts, hunting spans, and transcript counts are activity or observability indicators, not substitutes.
5. **Sensitive content is opt-in and least privilege.** Transcript content is disabled by default, environment-scoped, encrypted at rest, access-audited, redacted in logs and normal exports, and governed by configurable retention/deletion. Metadata-only views are separate from content access.
6. **Mutations are verified and audited.** Preview Graph package writes and Copilot Studio quarantine operations require confirmation, idempotency where possible, immutable local audit events, and provider read-after-write verification. Failed verification is a failed operation, never optimistic success.
7. **No permission over-request at sign-in.** Incremental delegated consent is grouped by capability. Application permissions are configured for background collectors and acquired by client credentials. The UI identifies which registered-app grant and which signed-in-user/environment role controls each feature.
8. **One durable backend authority.** Provider credentials, capability results, normalized records, checkpoints, jobs, audit events, and sensitive data are backend-owned. Browser local storage is not a production authority. Background ingestion is resumable, deduplicated, bounded, and single-writer safe.
9. **Preview is visible.** Preview APIs are labeled in UI and documentation, isolated behind per-capability configuration, and may be disabled without disabling stable read-only features.
10. **Direct cutovers only.** When a phase replaces local-storage reports, inferred classification, or another authority, it migrates once and removes the old read/write path in the same phase. Do not add aliases, dual writes, compatibility branches, or permanent feature flags. This rule applies to authority replacement, not to separately labeled sources with different purposes: official usage, audit, hunting, and transcripts may coexist but never overwrite or masquerade as one another.
11. **Production uses one shared database.** SQLite is the bounded local/transition implementation through Phase 13. Phase 14 migrates all environments and production data to PostgreSQL, removes the SQLite runtime path in the same change, and validates multi-instance leases, sessions, migrations, backup, and restore against that one database contract.

## Permission and role groups

The plan requires the capability registry and README to preserve this distinction: an **Entra API permission on the app registration** and an **administrator/security role assigned to a human or Dataverse application user** are different requirements. Admin consent to an API permission does not grant the human an admin role, and a human admin role does not add an API permission to the app.

| Capability group | Registered-app permission | Token mode | User, service, environment, and license requirements |
| --- | --- | --- | --- |
| Package catalog read | Microsoft Graph `CopilotPackages.Read.All` (least privilege) or `CopilotPackages.ReadWrite.All` | Delegated and application | Microsoft Agent 365 license. The endpoint documentation names no additional human Entra role; use the live probe rather than inventing one. |
| Package management | Microsoft Graph `CopilotPackages.ReadWrite.All` | Delegated only | Microsoft Agent 365 license. The endpoint documentation names no additional human Entra role. Update, block, unblock, and reassign are preview/global-cloud-only unless Microsoft documentation changes. |
| Directory principal lookup | Microsoft Graph `User.ReadBasic.All`, `Group.Read.All` | Delegated | Signed-in user and tenant admin consent. |
| Power Platform inventory | Power Platform API `ResourceQuery.Resources.Read` (API app ID `8578e004-a5c6-46e7-913e-12f58912df43`) | Delegated is the supported path; app-only must remain unavailable unless Microsoft documents and a live probe proves an exact inventory-capable RBAC assignment | Global Administrator, Power Platform Administrator, Dynamics 365 Administrator, or Global Reader sees all inventory. AI Administrator or AI Reader sees AI-scoped resources. Built-in Power Platform RBAC roles are not supported for inventory access. |
| Copilot Studio quarantine | Power Platform API `CopilotStudio.AdminActions.Invoke` | Delegated user token only | Global Administrator, AI Administrator, or Power Platform Administrator. Classic bots are unsupported. |
| Purview Audit Search | Microsoft Graph `AuditLogsQuery.Read.All` for cross-workload Copilot searches, or a narrower documented `AuditLogsQuery-*.Read.All` permission when a probe proves it covers the required records | Delegated and application | Audit must be enabled. Delegated users need an appropriate Purview **Audit Logs** or **View-Only Audit Logs** role. Audit Standard/Premium licensing controls retention and bandwidth. |
| Continuous audit feed | Office 365 Management APIs `ActivityFeed.Read` | Application preferred; delegated supported | Tenant admin consent; unified audit logging enabled; `Audit.General` subscription. |
| Defender/Agent 365 hunting | Microsoft Graph `ThreatHunting.Read.All` | Delegated and application | Microsoft Defender XDR access and applicable Agent 365/Microsoft 365 E7 or service licensing; delegated users need a Defender role that can run advanced hunting queries. |
| Dataverse transcript read as user | Dataverse delegated `user_impersonation` for each environment resource | Delegated | **Bot Transcript Viewer** Dataverse security role in each environment. Environment Maker alone is insufficient. Transcript saving must be enabled. |
| Dataverse unattended transcript ingestion | Dataverse application access through an application user; Dataverse uses environment security roles rather than a broad Entra application permission | Application | Create an application user in every selected environment and assign a custom least-privilege role with organization-level read only for the ConversationTranscript table and required metadata tables. Do not grant System Administrator to the collector. |

Agent Control itself also uses Entra application roles. Readers receive `AgentControl.Reader`; package/quarantine operators receive `AgentControl.Operator`; security/audit viewers receive `AgentControl.SecurityReader`; raw transcript viewers receive `AgentControl.TranscriptReader`; configuration, imports, identity review, and collector administration require `AgentControl.Administrator`. These roles do not replace provider API permissions or provider-side administrator/security roles.

The Graph Audit Search reference is internally inconsistent as of September 4, 2026: create/list-records pages use `AuditLogsQuery-*`, while the single-query GET page lists `ThreatIntelligence.Read.All`; resource pages also differ on `serviceFilter` versus `serviceFilters`. Phase 07 must prove the live contract in the target tenant and keep uncertainty visible rather than silently broadening privileges.

## Ordered implementation manifest

Execute these prompts in order, one per fresh session. Each prompt must be completed and its completion record reviewed before starting the next prompt. Review means checking the record against the phase's focused validation, aggregate validation, done conditions, and exact next-phase artifacts; a checklist or `passed` label without evidence is not review.

1. [01 - Domain, persistence, and provider foundations](01-domain-persistence-foundations.md)
2. [02 - Multi-resource authentication and capability registry](02-auth-capability-registry.md)
3. [03 - Permission Center and feature gating UX](03-permission-center-ui.md)
4. [04 - Power Platform inventory and normalized identity](04-power-platform-inventory.md)
5. [05 - Package catalog controls and reassignment](05-package-management.md)
6. [06 - Official usage-report ingestion](06-official-usage-ingestion.md)
7. [07 - Microsoft Graph Purview Audit Search](07-graph-audit-search.md)
8. [08 - Continuous Management Activity ingestion](08-management-activity-ingestion.md)
9. [09 - Defender and Agent 365 hunting](09-defender-agent365-hunting.md)
10. [10 - Copilot Studio quarantine controls](10-copilot-studio-quarantine.md)
11. [11 - Dataverse transcript ingestion and privacy](11-dataverse-transcripts.md)
12. [12 - Unified admin workbench, reporting, and export](12-unified-admin-workbench.md)
13. [13 - Security, operations, retention, and recovery](13-security-operations.md)
14. [14 - Production infrastructure and deployment](14-production-deployment.md)
15. [15 - Live qualification and production hardening](15-live-qualification.md)

## Completion records

Every phase owns exactly one completion record at `plans/admin-poc-production/completions/<phase-file-name>.md`. It must contain:

- phase outcome: `completed`, `completed_with_disabled_capabilities`, or, only where the production contract permits it, `deployment_pending`;
- outcome and exact behavior delivered;
- changed files grouped by repository root;
- data/schema migration and cutover result;
- permissions and roles added or changed;
- focused and aggregate validation commands with `passed`, `failed`, `not_run`, `unavailable`, or `inconclusive` status;
- live-provider probes attempted and tenant/environment used without secrets;
- residual risks with affected capability, containment, production telemetry/canary, alert threshold, owner, and fix-forward trigger;
- exact next-phase preconditions.

The `completions/` directory is created by implementation workers. Completion records and this README are not executable phases.

In this campaign, **availability** means a capability's current provider contract and prerequisites are responding, **coverage** means which environments/resources/records were observed within a stated boundary, and **freshness** means the age of the evidence. Empty data can be available with zero observed coverage; stale success is not current availability.

## Always-deploy production contract

This campaign is explicitly authorized and required to end with deployment through the repository's production tooling, observation of the exact deployed revision, and fix-forward handling. It must not terminate at local success, test readiness, a GO/NO-GO document, or an undeployed demonstration.

- Attempt every local, browser, integration, migration, restore, capacity, and provider check and report its real result.
- Repair every reproducible defect as far as practical. Never relabel `failed`, `not_run`, `unavailable`, or `inconclusive` evidence as passing.
- A non-passing preproduction check does not cancel deployment. Carry the residual with affected scope, containment, telemetry/canary, threshold, owner, and fix-forward trigger.
- Keep unsafe mutations, transcript content, or unsupported preview capabilities disabled or quarantined while deploying schema, adapters, observability, permission guidance, and unaffected capabilities.
- Use bounded exposure through the capability registry, explicit environment selection, ingestion limits, and provider controls. Do not restore legacy authorities or add compatibility code to make deployment easier.
- Qualify synthetic production behavior only in isolated namespaces/environments and remove test data afterward. Cleanup failure remains an active cost/security incident but does not cancel deployment.
- Production feedback drives repeated containment, root-cause repair, focused validation, redeployment, and canary execution.
- Only literal inability to execute production control-plane actions may leave the campaign `deployment_pending`. Record the exact identity, missing action, command, and resumable next step; do not close the campaign as production-ready.

## Global validation baseline

Every phase runs the narrowest tests for its changes plus the applicable aggregate commands:

```bash
npm run test --workspace backend
npm run test --workspace frontend
npm run typecheck --workspace backend
npm run lint --workspace frontend
npm run build
git diff --check
```

Provider integration tests must use deterministic HTTP fixtures for protocol behavior and non-mutating live probes where credentials, licensing, and tenant rollout are available. Secrets, tokens, transcript content, user prompts, and raw sensitive audit data must never be written to completion records, logs, screenshots, or fixtures.