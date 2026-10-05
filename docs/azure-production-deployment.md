# Azure production deployment

**Current development contract:** there is one current schema, identified by the compiled SHA-256 `schemaFingerprint` and a singleton `app_schema` marker. There is no migration chain, numeric schema baseline or old-data conversion. An incompatible database requires an explicit authorized reset, not a deployment upgrade. This change is code-only: no current database, container, Azure operation, deployment or reset was executed or qualified. Historical roadmap receipts are not evidence for this schema.

`deploy-azure.ps1` is the only Azure release entry point. It deploys one tested Express/React Linux/x64 ZIP to one Linux Basic B1 App Service and one PostgreSQL 17 Flexible Server (`Standard_B1ms`, Burstable, 32 GiB, seven-day backup retention). It reuses one administrator-prepared Key Vault. It never creates a VM, database container, container registry, Static Web App, slot, replica, HA pair, autoscale target, Redis, Cosmos DB or Azure Files share.

## Approval file and preview

Copy `infra/production-target.example.json` to an access-restricted, ignored location and complete it without secret values. `isApproval` must be `true`. Bind the exact primary tenant, subscription, resource group, region, app registration, App Service/plan/PostgreSQL resource IDs, database `agentcontrol`, selected/current vault versions, tenant-routing inputs below, exact runner/App Service IPv4 addresses and installation mode. A first install must say `fresh`, explicitly approve initialization, and encounter an empty schema. `existing` requires the exact compiled current schema fingerprint, not an operator-selected version. Omit `expectedSchemaVersion` entirely; even an empty or null value is rejected. Missing/inaccessible storage, changed credentials, an incompatible schema, or existing resources on a fresh target fail closed. Previously deployed vault versions must remain unchanged; the wizard has no credential-rotation or standalone-configuration conversion authority.

Only `fresh` and `existing` installation modes are supported; `upgrade` has no alias. SQLite audit import and old Static Web App retirement have been removed, including the standalone importer/SQLite backup helper and their deployment actions. Old modes and named baseline/backup parameters fail explicitly. Target files must omit `legacyAuditBackupPath`, `legacyAuditBackupSha256` and `legacyStaticWebApp` entirely: their presence is rejected even when empty, false or null, before any external operation. Obtain approval for the revised target; never rewrite an old receipt to bypass validation. Receipts recording removed steps, including `database_migrate`, cannot resume; unfinished old workflows require separate operator reconciliation, not replay.

This code change does not delete existing resources, databases, saved dumps or receipts. It deliberately removes old-schema compatibility from future execution. Backup/restore accepts only the current compiled schema; old dumps are not converted. Historical roadmap completion records remain evidence of earlier workflows, not current executable instructions.

Record a current itemized monthly estimate in one currency for App Service, PostgreSQL compute, storage, backup, monitoring, existing Key Vault operations, required networking and one temporary restore drill. Use a dated Azure Pricing Calculator estimate or another approved current Microsoft pricing source. Unavailable pricing/SKU evidence stops deployment; fixture prices are never a quote. Any target/tier change requires a revised file, estimate and approval. Record a monthly budget ceiling, change approver/reference, maintenance window of at most eight hours, and explicit acceptance of the Burstable POC limitations.

Microsoft's PostgreSQL [compute guidance](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-compute) warns that Burstable is not recommended for production, does not include 24/7 support and can severely degrade or become unreachable after CPU credits are exhausted. The wizard never upgrades automatically. Repeated credit depletion requires a new capacity estimate and approval.

After explicit Azure authorization:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -TargetFile <approved-target.json>
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile <same-approved-target.json>
```

`Plan` checks PowerShell 7, Docker and Azure CLI, exact authenticated primary tenant/subscription, regional SKU evidence, all four required vault values, operator read and ARM-template readiness, exactly the two enabled Entra role values `AgentControl.Viewer` and `AgentControl.Admin` with Users/Groups-only `allowedMemberTypes`, callback, **Assignment required? = Yes**, and an Admin assignment in the primary registration, existing-resource identity, artifact checksum and Bicep what-if. The verifier resolves that assignment against the actual registered Admin role GUID, not the manifest ID, so equivalent roles created manually in the portal are supported. It does not prove role-ID freshness in an existing tenant or enforce effective per-user assignment cardinality; fresh IDs remain separate migration guidance. Deploy requires all three selected native App Service reference statuses, administrator-secret exclusion and restricted database login proof. The wizard only previews directory differences; it never writes app registrations, consent, assignments or provider grants. Review the redacted receipt and use the unchanged approval for `Deploy`.

An optional `-QualificationTargetsFile` must be a current explicit approval matching the deployed tenant, app and origin. The wizard validates its expiry (at most 30 days), restoration owner, exact persona role names and exact reversible Copilot Studio native environment/bot target; it performs no provider read or write. Without approval, those optional Phase 13 persona/canary checks are not run; ordinary Admin-confirmed package and quarantine operations do not require this file or prior canary evidence.

## Tenant configuration

Each configured tenant may keep its own **single-tenant** Entra app registration. Register this deployment's identical `/api/auth/callback` Web redirect URI in every application and configure the existing Viewer/Admin roles, Enterprise-application assignments, delegated/API grants and administrator consent in each tenant. Users enter their username; there is no tenant picker or UI tenant management. Exact configured domains route sign-in, with no tenant discovery or fallback, including for a deployment with only one profile.

**The tenant registry is required for every deployment.** Standalone runtime identity variables have no supported mode or alias. Target-level `tenantDomains` / `tenantDisplayName` and the corresponding named options are removed; domains and display names belong to each registry profile. Primary `-TenantId` / `-AppRegistrationClientId` inputs remain approval/registration metadata, not standalone runtime credentials.

1. Prepare `agent-control-tenants-json` directly in the approved Key Vault with the [tenant-array schema](deployment-setup.md#tenant-registry-and-domain-routing). Keep the entire credential-bearing value out of source, shell arguments, target/parameter files, receipts and logs.
2. Set `tenantRegistrySecretName` to `agent-control-tenants-json`. The four required names in `preparedVaultContract.secretNames` are the registry, session secret, operator database password and runtime database password. `runtimeConsumers` contains exactly the registry, session and runtime database secrets. Pin all four non-secret version references in `versions`; the registry must contain the approved primary tenant/application.
3. Record `tenantRegistryRegistrationApprovalReference` for administrator verification of the shared callback, roles, assignments and grants in **every configured tenant**. Automated directory verification covers only the primary registration; receipts explicitly mark additional registrations as not automatically verified. This reference is not live authentication/provider proof.
4. For every existing deployment, include all four current `existingVersions`, unchanged from the selected versions. A missing registry version is rejected; there is no first-conversion exception. Changes to existing credentials require the coordinated-rotation prerequisite, not a version-check bypass.
5. Review `Plan`, then use the unchanged approval for `Deploy`. Named inputs are `-TenantRegistrySecretName agent-control-tenants-json` and `-TenantRegistryRegistrationApprovalReference`; version metadata still uses the existing secret-version inputs. Bicep receives only the secret name/version and installs a native **`TENANTS_JSON` Key Vault reference**, never a literal JSON app setting.

The wizard validates profile GUIDs, credentials, nonempty exact domain arrays, uniqueness and preservation of the primary tenant without logging the value. Native-reference verification checks the registry's exact vault/name/version and `Resolved` status; resolved session/database references cannot mask a missing or unresolved registry. Backups, maintenance, database secrets, release containment and the shared callback remain deployment-wide.

## Maintenance and release order

For an existing target the wizard reconciles exact egress, creates one run-owned exact-IP runner firewall rule, closes admission, stops/drains the old process, creates a managed backup, and requires that exact run-named backup to appear as a completed restore point from the exact server through the supported backup control-plane API. Database preflight invokes `preflight existing agentcontrol` and requires the compiled fingerprint. `database_initialize` explicitly invokes `database.ts initialize` to verify the schema and runtime grants; it never transforms an old schema. It then deploys the exact ZIP with remote build disabled and verifies selected native vault references, runtime least privilege (including `schema_read`) and monitoring. For a fresh target, Bicep creates the site in maintenance and stops it before bootstrap. `preflight fresh agentcontrol` requires an empty schema, then initialization creates the current schema directly and the wizard verifies the first run-named backup before opening.

An incompatible schema fails with `database_schema_reset_required`; Azure deployment does not automatically reset it. An explicitly approved development reset is a separate destructive operation. A local `start -DbReset` discards only its owned application database and initializes the current schema without creating or requiring a pre-reset backup. Tenant configuration, credentials, unrelated databases and saved backup files remain outside that reset boundary.

The wizard then starts the app with application and database admission closed, performs bounded read-only route/configuration checks, and requires a separate exact-run human authentication-smoke receipt. Only then does it reopen the database with provider work disabled, remove `MAINTENANCE_MODE`, and verify bounded readiness/auth configuration. Liveness is never login proof. A resource-deployment or post-open failure explicitly reapplies maintenance, stops the app, and records containment.

Receipts contain resource IDs, non-secret vault versions, artifact revision/checksum/architecture, schema fingerprints/backup results, monitoring evidence, completed steps and exact cleanup ownership, never secret values. Resume or cleanup requires `-ResumeReceiptPath` for that exact run; target/approval/ownership mismatches are rejected. Completed external writes are not replayed. A fresh resume accepts only exact wizard-tagged resources and an empty schema before initialization, or the exact current fingerprint after `database_initialize`. Every existing-target resume requires the current fingerprint, including interruptions before initialization. Failed deletion preserves unresolved ownership and cannot report cleanup success.

Without `-AuthenticationSmokeReceiptPath`, a real Deploy/Recover pauses successfully as `awaiting_authentication_smoke` with the app running under `MAINTENANCE_MODE=true` and the database still in maintenance. An authorized human completes the real login/callback/session check against the receipt's exact run/origin/revision, then creates a restricted non-secret JSON approval containing `receiptVersion: 1`, `isApproval: true`, `evidenceType: "human_operator"`, `deploymentRunId`, `targetApprovalDigest`, `canonicalOrigin`, `callbackUri`, `artifactSha256`, `loginCallbackSessionVerified: true`, `performedAt`, `approvedBy`, and `reference`. Resume only that receipt:

```powershell
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile <same-approved-target.json> `
  -ReceiptPath <same-deployment-receipt.json> -ResumeReceiptPath <same-deployment-receipt.json> `
  -AuthenticationSmokeReceiptPath <restricted-auth-smoke-receipt.json>
pwsh ./deploy-azure.ps1 -Action Cleanup -TargetFile <same-approved-target.json> `
  -ReceiptPath <same-deployment-receipt.json> -ResumeReceiptPath <same-deployment-receipt.json>
```

Invalid authentication evidence triggers containment and app stop. `Cleanup` is for a failed/contained receipt's exact allowlisted temporary ownership; it cannot invent a new run or delete retained/server resources.

App Service diagnostics send only the application's redacted `AppServiceConsoleLogs` category to the dedicated table plus aggregate `AllMetrics`; raw App Service HTTP/IP/URL categories are disabled. PostgreSQL sends aggregate `AllMetrics` only and no server, session, connection or query logs. Scheduled queries extract only `tostring(parse_json(ResultDescription).event)` and compare exact event names; they do not token-search the full JSON message.

Managed metric alerts cover readiness `HealthCheckStatus` below 100% over five minutes (including silent application failure), HTTP 5xx, two-second average latency, PostgreSQL storage and Burstable CPU credits. Runtime structured-event alerts cover restarts, provider failures, finite-deadline worker stops, uncertain dispatched writes, pool errors/waiters, session-store errors and cleanup failures. The `backup_storage_used` alert is explicitly a 32-GiB cost signal, not backup-health evidence. Backup health is the bounded exact-server/exact-run control-plane restore-point probe described above; missing, delayed beyond the bound, mismatched or failed evidence blocks the release.

Log Analytics retention is 30 days with the approved 0.1-GiB daily ingestion cap. Budget alerts are notifications, not spending caps. Alert delivery, current managed capacity, regional availability and actual cost require live approved proof.

An authorized operator may recheck the receipt-bound backup without creating or restoring anything:

```powershell
az postgres flexible-server backup show --subscription <exact-subscription-id> `
  --resource-group <exact-resource-group> --name <exact-server-name> `
  --backup-name <exact-release-backup-name-from-receipt> --only-show-errors -o json
```

The result is acceptable only when its backup name and source server match the receipt exactly, its completion time falls within the approved maintenance window, and any reported state is `Completed`, `Ready` or `Succeeded`. Missing/failed evidence is not replaced by `backup_storage_used`.

## Prepared vault and network

The four required secret names and validation rules are in `docs/deployment-setup.md`. Bicep resolves the administrator password only through a native secure module input. The system-assigned App Service identity receives per-secret `Key Vault Secrets User` assignments for exactly three versioned runtime references: `TENANTS_JSON`, `SESSION_SECRET` and `PGPASSWORD`. The wizard queries App Service's native configuration-reference status endpoint with bounded propagation retries and requires the complete exact set of names/versions to be `Resolved`; inherited access to the administrator secret fails preflight. Bootstrap writes the two database passwords only to a separately tracked run-owned mode-0600 directory immediately before an ephemeral operator container, verifies both files, mounts it read-only, and removes it in `finally`. Registry JSON is validated in memory, never written to bootstrap/parameter files. The deployment wizard never changes credentials.

PostgreSQL enforces TLS 1.2 and the application uses `verify-full`. Persistent firewall entries are exact approved App Service outbound IPv4 addresses. The only runner rule is one exact approved IP with a run-specific name; broad/all-Azure access is forbidden. Changed egress requires renewed approval. Private networking is a separate tenant-policy/cost decision and must have an approved reachable runner; the wizard never creates a VM workaround.

Local deterministic coverage is:

```powershell
pwsh ./scripts/azure-deployment.tests.ps1
```

Mocks execute the real operation implementations but intercept every external command at the command boundary. Exact ordered arguments and responses are required; an unlisted or extra command is rejected and never falls through to Azure CLI, HTTP, Docker or a provider. Mock preview, deployment, PITR, recovery, monitoring and alert evidence must be labeled mock.
