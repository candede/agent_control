# Azure production deployment

`deploy-azure.ps1` is the only Azure release entry point. It deploys one tested Express/React Linux/x64 ZIP to one Linux Basic B1 App Service and one PostgreSQL 17 Flexible Server (`Standard_B1ms`, Burstable, 32 GiB, seven-day backup retention). It reuses one administrator-prepared Key Vault. It never creates a VM, database container, registry, Static Web App, slot, replica, HA pair, autoscale target, Redis, Cosmos DB or Azure Files share.

## Approval file and preview

Copy `infra/production-target.example.json` to an access-restricted, ignored location and complete it without secret values. `isApproval` must be `true`. Bind the exact tenant, subscription, resource group, region, app registration, App Service/plan/PostgreSQL resource IDs, database `agentcontrol`, selected/current vault versions, exact runner/App Service IPv4 addresses and installation mode. A first install must say `fresh`, explicitly approve first initialization, and encounter an empty database baseline reported as schema `0` during preflight. An upgrade may explicitly approve existing schema `26` as the two-role cutover baseline; a repeated deployment of the current release approves schema `27`. The selected baseline must match the database observed before migration. Missing/inaccessible storage, changed credentials, any other schema, or an existing resource on a fresh target fails before initialization. Every selected vault version must equal the currently deployed version. Any change is rejected until Phase 11's separately approved coordinated-rotation procedure has completed and a new current-version receipt exists; this wizard has no credential-rotation authority. The checked-in production-target example names schema `27` for current deployments.

Record a current itemized monthly estimate in one currency for App Service, PostgreSQL compute, storage, backup, monitoring, existing Key Vault operations, required networking and one temporary restore drill. Use a dated Azure Pricing Calculator estimate or another approved current Microsoft pricing source. Unavailable pricing/SKU evidence stops deployment; fixture prices are never a quote. Any target/tier change requires a revised file, estimate and approval. Record a monthly budget ceiling, change approver/reference, maintenance window of at most eight hours, and explicit acceptance of the Burstable POC limitations.

Microsoft's PostgreSQL [compute guidance](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-compute) warns that Burstable is not recommended for production, does not include 24/7 support and can severely degrade or become unreachable after CPU credits are exhausted. The wizard never upgrades automatically. Repeated credit depletion requires a new capacity estimate and approval.

After explicit Azure authorization:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -TargetFile <approved-target.json>
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile <same-approved-target.json>
```

`Plan` checks PowerShell 7, Docker and Azure CLI, exact authenticated tenant/subscription, regional SKU evidence, six vault values, operator read and ARM-template readiness, exactly the two enabled Entra role values `AgentControl.Viewer` and `AgentControl.Admin` with Users/Groups-only `allowedMemberTypes`, callback, **Assignment required? = Yes**, and an Admin assignment, existing-resource identity, artifact checksum and Bicep what-if. The verifier resolves that assignment against the actual registered Admin role GUID, not the manifest ID, so equivalent roles created manually in the portal are supported. It does not prove role-ID freshness in an existing tenant or enforce effective per-user assignment cardinality; fresh IDs remain separate migration guidance. Deploy separately requires all five native App Service reference statuses plus administrator-secret exclusion and restricted database login proof. The wizard only previews directory differences; it never writes app registrations, consent, assignments or provider grants. Review the redacted receipt and use the unchanged approval for `Deploy`.

An optional `-QualificationTargetsFile` must be a current explicit approval matching the deployed tenant, app and origin. The wizard validates its expiry (at most 30 days), restoration owner, exact persona role names and exact reversible Copilot Studio native environment/bot target; it performs no provider read or write. Without approval, those optional Phase 13 persona/canary checks are not run; ordinary Admin-confirmed package and quarantine operations do not require this file or prior canary evidence. If the approved target names a legacy Static Web App, the wizard verifies its exact ID and `app=agent-control` ownership and retires it only after the new single-app smoke; no identity means no deletion.

## Maintenance and release order

For an existing target the wizard reconciles exact egress, creates one run-owned exact-IP runner firewall rule, closes admission, stops/drains the old process, creates a managed backup, and requires that exact run-named backup to appear as a completed restore point from the exact server through the supported backup control-plane API. It verifies the selected existing baseline (`26` for an explicitly approved cutover or `27` for the current release), then migrates under the existing advisory lock to release schema `27`. After the `database_migrate` checkpoint, every resume requires schema `27`; it cannot resume against the earlier selected baseline. It then optionally imports only a SQLite-safe audit backup, deploys the exact ZIP with remote build disabled, verifies five native vault-reference resolution statuses and runtime least privilege, and verifies monitoring. For a fresh target, Bicep creates the site with `MAINTENANCE_MODE=true`; resource deployment immediately reapplies that setting and stops the site before bootstrap. The wizard requires schema `0`/an empty database, initializes it directly to schema `27`, and creates/verifies the first run-named backup before opening.

Migration `27` changes only the package and Power Platform refresh-job status constraints by adding `cancelled` for owned Viewer read-job cancellation; it does not modify session or capability-cache tables. The same release separately changes application authorization: users sign in again for current Viewer/Admin claims, legacy roles are never aliased or implicitly upgraded, principal capability evidence is reacquired or revalidated, and existing session/account fencing remains authoritative. Business data remains subject to its existing tenant, principal, source, and retention boundaries.

The wizard then starts the app with application and database admission closed, performs bounded read-only route/configuration checks, and requires a separate exact-run human authentication-smoke receipt. Only then does it reopen the database with provider work disabled, remove `MAINTENANCE_MODE`, and verify bounded readiness/auth configuration. Liveness is never login proof. A resource-deployment or post-open failure explicitly reapplies maintenance, stops the app, and records containment.

Receipts contain resource IDs, non-secret vault versions, artifact revision/checksum/architecture, schema/backup/import results, monitoring evidence, completed steps and exact cleanup ownership. They never contain values. Resume or cleanup requires `-ResumeReceiptPath` for that exact run; target/approval/ownership mismatches are rejected. Completed external writes are not replayed. A receipt-bound fresh resume accepts only the exact wizard-tagged resources and verifies schema `0` before initialization or schema `27` after initialization/migration; an existing-target resume after `database_migrate` likewise requires `27`. Failed deletion preserves the unresolved ownership record and cannot report cleanup success.

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

The six exact names and validation rules are in `docs/deployment-setup.md`. Bicep resolves the administrator password only through a native secure module input. The system-assigned App Service identity receives per-secret `Key Vault Secrets User` assignments for exactly five versioned runtime references. The wizard queries App Service's native configuration-reference status endpoint with bounded propagation retries and requires all five exact names/versions to be `Resolved`; inherited access to the administrator secret fails preflight. Bootstrap writes the two database passwords only to a separately tracked run-owned mode-0600 directory immediately before an ephemeral operator container, verifies both files, mounts it read-only, and removes it in `finally`. The deployment wizard never changes credentials.

PostgreSQL enforces TLS 1.2 and the application uses `verify-full`. Persistent firewall entries are exact approved App Service outbound IPv4 addresses. The only runner rule is one exact approved IP with a run-specific name; broad/all-Azure access is forbidden. Changed egress requires renewed approval. Private networking is a separate tenant-policy/cost decision and must have an approved reachable runner; the wizard never creates a VM workaround.

Local deterministic coverage is:

```powershell
pwsh ./scripts/azure-deployment.tests.ps1
```

Mocks execute the real operation implementations but intercept every external command at the command boundary. Exact ordered arguments and responses are required; an unlisted or extra command is rejected and never falls through to Azure CLI, HTTP, Docker or a provider. Mock preview, deployment, PITR, recovery, monitoring and alert evidence must be labeled mock.
