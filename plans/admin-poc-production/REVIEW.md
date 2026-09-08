# Plan Review Decisions

This is a plan-design review, not an implementation completion record. The campaign now has 13 ordered prompts for manual execution in separate fresh sessions. The approved simplification below supersedes the original broader capability-demonstration scope and earlier review recommendations. No application code, provider roles, cloud resources or production data were changed.

## Current intent

Build a small single-tenant inventory-and-controls workbench: packages, Power Platform inventory, three-file official CSV usage, on-demand Purview search, curated Defender/Agent 365 hunting, quarantine, Permission Center and ordinary administrative history. Keep exact identity, source authority, scope, coverage and freshness explicit. Deploy one Express-served React artifact and observe the retained product in production.

## Approved simplifications

| Removed now                                                                                  | Retained boundary / owner                                                                                                               |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| All Dataverse transcript access/storage/viewing/analytics and its app role/grants            | Inventory native bot/environment IDs and quarantine remain; four-role policy in 02                                                      |
| Transcript encryption, reveal, redaction, legal holds and deletion-ledger recovery machinery | Ordinary data minimization/retention and documented backup limits, 01/feature owners/11                                                 |
| Custom audit hash chains, signing keys/checkpoints/outboxes                                  | Ordinary append-only audit, restrictive runtime privileges, logs and backups, 01/11                                                     |
| Original CSV and unrestricted provider response archives                                     | Validated rows and allowlisted useful fields with provenance, 04-08                                                                     |
| SWA split hosting/release, slots, HA/autoscale and mirrored cloud stack                      | One Docker-built artifact/origin in 01, integrated proof in 10; single-instance maintenance deployment and isolated backup checks in 12 |
| Mandatory certificate/federation credential migration                                        | Existing supported MSAL credentials in protected settings, 02/12; in-memory tokens and explicit reauthentication after restart          |
| Interactive maintenance/backup/retention console                                             | Small user-job view in 10; operator status, alerts and commands in 11                                                                   |
| Prompt/per-file hashes and copied cumulative risk paperwork                                  | Concise completion template, origin issue links and exact next action; release checksum evidence in 12/13                               |
| Continuous Management Activity feed/subscriptions                                            | On-demand Purview in 07; two-source audit UI in 10                                                                                      |
| Scheduled inventory/hunting harvesting                                                       | Explicit bounded refresh/search and job completion, 04/05/08                                                                            |
| Manual identity review/link/merge/split platform                                             | Exact typed-ID associations; ambiguous/unmatched sources stay separate, 04 and consumers                                                |

The old feed and transcript prompts were deleted, not converted into empty scaffolding phases. The new order is foundations/auth/permissions (01-03), inventory/packages/reports/Purview (04-07), hunting/quarantine (08-09), workbench (10), security/operations (11), deployment (12) and live qualification (13).

Useful deferred ideas and their revisit conditions live only in [FUTURE-IDEAS.md](FUTURE-IDEAS.md), explicitly **not to implement now**. They are not disabled POC features or prerequisites for completion.

## Two-script deployment decision

- Phase 01 now owns `deploy-local.ps1`, a multi-stage Docker build and Compose with two long-running containers: combined Express/React and PostgreSQL. All application build/test/migration/browser tooling runs in temporary Docker targets; the host needs PowerShell/Docker and a browser, not Node/Vite/PostgreSQL. Reruns preserve data and secret files; missing DB secrets with existing data require recovery, not reset. Keep one canonical local origin and outbound access to Entra/providers.
- Phase 12 owns `deploy-azure.ps1` and retires `deploy-production.ps1` without a compatibility wrapper. Azure receives a compatible prebuilt Linux ZIP exported from the same Docker build; no custom-image registry or separate frontend is required.
- Azure starts by evaluating one Basic B1 App Service and managed PostgreSQL Flexible Server Burstable B1ms, 32 GiB, seven-day backups, no HA/replicas. This is a hosted POC, not an enterprise availability promise. Current itemized estimates, region/capacity checks and explicit budget approval precede paid changes; telemetry and temporary restore costs are included. No database VM/container or silent tier upgrade.
- Confirmed Azure choice: the same App Service serves the React frontend and Express backend; managed PostgreSQL stores their data. Its underlying host is Microsoft-operated, not a customer-managed VM or a separate VM deployment/bill. One App Service Plan supplies app compute. Container Apps/database sidecars/Azure Files NFS are not selected; no further hosting branch is needed. Managed-service/network policy approval still applies.
- Persistence is required locally and in Azure across ordinary restarts and redeployments. Phase 12 guards existing database identity and fails for recovery when an expected target is absent/inaccessible rather than initializing a replacement. Phase 13 records before/after integrity across app restart, managed database restart and repeat release; local named-volume proof remains in Phase 01. Backup restore is for separate recovery, not ordinary redeployment; ephemeral MSAL tokens still require reauthentication.
- The Azure wizard takes the existing full Key Vault resource ID and validates the six exact README secret names. Phase 02 owns administrator preparation guidance. Vault values stay administrator-owned; native ARM secure references and restricted operator containers perform bootstrap, while app managed identity can read only the five runtime secrets, never the admin password. Phase 11 owns coordinated manual rotation/recovery; repeat deployment never silently changes credentials or broadens access.
- Cosmos DB is not a selectable implementation branch. Its possible free allowance does not remove a relational/transaction redesign, eligibility checks or overage costs. A storage/hosting redesign is future-only and requires a separate decision if the verified managed PostgreSQL cost exceeds budget.

Checked Microsoft documentation for [PostgreSQL compute tiers and limits](https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-compute), [Cosmos DB free-tier constraints](https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier), [Key Vault template-deployment permissions and secret references](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/key-vault-parameter) and [Linux App Service filesystem/SQLite restrictions](https://learn.microsoft.com/en-us/troubleshoot/azure/app-service/faqs-app-service-linux-new). These establish design constraints, not a regional price quote or live deployment proof. Recheck service limits/pricing during execution.

## Safety retained

- PostgreSQL from Phase 01 and one-time legacy-audit-only preservation in Phase 12; no throwaway new SQLite architecture or runtime fallback.
- Principal-scoped capability evidence, additive roles and saved-data authorization before joins/counts/exports. Persistent sessions do not contain tokens; delegated jobs await reauthentication when MSAL's memory cache is lost.
- Durable intent, exact source-native mutation targets, confirmation, readback, uncertain-outcome reconciliation and approved reversible canaries. Local leases/prestate hashes are not remote compare-and-swap.
- Backend-owned three-file report staging and atomic selection, source timestamps and confirmed legacy browser cleanup; no metric substitution.
- Early security/test owners, bounded query protocols, finite ordinary retention, source-safe exports and honest unavailable evidence.
- Real authorized deployment, observation and fix-forward; no forced unsafe exposure or test-only terminal report.

## Evidence and limits

Reviewed every numbered prompt and relevant current persistence/job/package implementation anchors, with independent read-only architecture, execution and production reviews followed by parent verification. Rejected findings based on not-yet-implemented code, invented contradictions, or suggestions that restored explicitly removed architecture. Consistency alone was not treated as proof that the original design was simple enough.

Earlier documentation checks informed the retained Graph Audit Search contract and hunting workspace-fallback constraints, plus safe retirement of old hosting dependencies. Historical feed/SWA implementation requirements are no longer scope. Provider permission/licensing/preview claims remain execution-time documentation and live-probe obligations; this review does not certify tenant eligibility or all current Microsoft contracts.

Validation covers ordered manifest/file parity, unique completion paths, required sections, sequential requirements, local Markdown links, formatting, diagnostics and diff hygiene. Application tests, live consent/probes, infrastructure provisioning, capacity, migration and production canaries belong to implementation; they were not run as evidence for this document review.

## Remaining external prerequisites

The executing operator must supply local PowerShell/Docker prerequisites, approved Azure target/cost/maintenance boundaries, the existing prepared Key Vault and its exact secret/ARM/runtime permissions, required app-role assignment and applicable provider consent, an authorized connection to the selected database/network, and optional canary approvals. Available Azure tiers/policy and live preview contracts must be verified during execution. Missing budget or access approval never authorizes paid changes. Retained unavailable providers stay visibly disabled; removed features remain absent. Healthy deployed core behavior and actual production observation close the campaign.
