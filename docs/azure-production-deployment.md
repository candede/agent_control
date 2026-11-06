# Azure production deployment

Deploy or update Agent Control on Linux App Service with PostgreSQL Flexible
Server using `deploy-azure.ps1`. Run commands from the repository root.
Optional MCP deployment is [separate](#optional-independent-mcp-app-service).

## Before you start

- Git, PowerShell 7, Docker with Buildx, Azure CLI and standalone
  [Bicep CLI](https://learn.microsoft.com/azure/azure-resource-manager/bicep/install#install-manually).
- Existing resource group, Key Vault and monitoring action group in the target
  subscription.
- Deployment/role-assignment permissions, selected-secret read and vault template
  deployment access, and access to review Entra registrations/assignments/consent.
- Exact App Service outbound IPv4 addresses and runner IPv4 for temporary
  PostgreSQL firewall access; no broad firewall rules.

The script requires infrastructure change/cost approvals in its target file.
These records do not authorize application users or gate login or synchronization.

## Supported deployment profile

| Resource | Supported configuration |
| --- | --- |
| App Service | One Linux Basic B1 instance; Node 24; remote build disabled |
| PostgreSQL | Version 17, `Standard_B1ms`, Burstable, 32 GiB; storage autogrow off |
| Database availability | Seven-day backup retention; no HA, replicas or geo-redundant backup |
| Application pool | Maximum four connections |
| Monitoring | 30-day retention; 0.1 GiB daily ingestion cap; existing action group |

Other tiers/sizes require template and script changes. Review
[PostgreSQL compute limitations](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-compute)
against the expected workload and budget before choosing this profile.

The [Bicep parameter example](../infra/main.bicepparam) reflects the required
tenant-registry secret contract; replace its non-secret placeholders with exact
target identities and immutable secret version IDs. The deployment script writes
its own parameters from the target file.

The administrator password enters the secure `postgresAdminPassword` parameter
through a native ARM Key Vault reference pinned to the selected secret version.
The generated parameter file contains only the vault ID, secret name and version;
the example uses the parameter-file `az.getSecret` function to emit that reference.
No administrator secret value is written to either file or exposed to the runtime.

API log alerts filter the shared workspace by the API App Service resource ID;
MCP or other applications' events do not contribute to their thresholds.
The rules are enabled immediately but skip deployment-time query validation
because `AppServiceConsoleLogs` is created only after the first console-log
ingestion. This does not disable alert evaluation once logs arrive.

## 1. Configure Entra sign-in

Follow [Entra setup](deployment-setup.md#configure-the-entra-application) for
each tenant. Use this **Web** redirect URI in every registration:

```text
https://<app-host>/api/auth/callback
```

Replace `<app-host>` with the production hostname. Require enterprise-application
assignment and assign at least one `AgentControl.Admin`. Use the
[permissions reference](user-roles-and-permissions.md) for roles, Microsoft
permissions, licensing and consent. Review every tenant: the script checks only
the primary registration's callback, roles and assignments and never changes
Entra configuration.

## 2. Prepare Key Vault

Enable vault RBAC authorization and template deployment. Prepare enabled,
unexpired versions through your protected secret-management process:

| Secret name | Consumer and value |
| --- | --- |
| `agent-control-tenants-json` | Application tenant registry: JSON array of tenant profiles |
| `agent-control-session-secret` | Application sessions: at least 32 UTF-8 bytes |
| `agent-control-postgres-admin-password` | Database operator only: at least 32 characters |
| `agent-control-postgres-app-password` | Application database role: at least 32 characters; different from the administrator password |

Each tenant profile needs `tenantId`, `clientId`, `clientSecret` and a nonempty
`domains` array of exact sign-in domains; `displayName` is optional. Tenant IDs
and domains must be unique. For MCP, add the API
[integration binding](mcp-reference.md#advanced-service-configuration).
Session/database secrets must not contain newlines or NUL characters.

Runtime receives only `TENANTS_JSON`, `SESSION_SECRET` and `PGPASSWORD`; its
identity must not read the admin password, including through inherited grants.
Keep values out of source control, arguments, target files, receipts and logs.
Record only secret names/version IDs.

## 3. Prepare the target file

Copy [`infra/production-target.example.json`](../infra/production-target.example.json)
to the gitignored `.local/` directory:

```powershell
$targetFile = Join-Path $PWD '.local/azure/production-target.json'
New-Item -ItemType Directory -Force (Split-Path $targetFile) | Out-Null
if (Test-Path $targetFile) { throw 'Target already exists; edit it instead.' }
Copy-Item ./infra/production-target.example.json $targetFile
```

Restrict access to deployment operators. Fill every placeholder; keep the
supported profile values:

| Fields | Input |
| --- | --- |
| `contractVersion`, `isApproval` | Keep `2`; set `isApproval=true` only for the reviewed infrastructure target |
| Tenant/subscription/group/region, Entra ID, vault/action-group IDs | Exact identities; Entra needs the application/client GUID, not object ID |
| `canonicalOrigin`, `callbackUri`, `tenantRegistryRegistrationApprovalReference` | HTTPS origin, exact callback and tenant-registration review reference from step 1 |
| Resource names, `expectedResourceIds`, `expectedDatabaseName` | Matching full ARM IDs; database must be `agentcontrol` |
| `approvedAppOutboundIpv4Addresses`, `runnerIpv4Address` | Exact addresses from the prerequisites |
| `preparedVaultContract.versions` | One selected version for each of the four secrets |
| `estimate`, `approvedMonthlyBudget`, monitoring budget dates | Itemized estimate within 31 days, source/currency, exact total and sufficient budget |
| `operatorApproval`, `maintenanceApproval`, `riskAcceptance` | Operator/change reference, UTC maintenance window ≤8 hours and Burstable risk acceptance |

Choose the installation mode:

| Mode | Required target state |
| --- | --- |
| `fresh` | App Service, plan and PostgreSQL targets absent; `firstInstallApproved=true`, `existingVersions=[]`. Initialization requires an empty database. |
| `existing` | Exact resources and current schema exist; `firstInstallApproved=false`. Supply all four deployed `existingVersions`. |

For `existing`, selected/deployed versions must match; Plan/Deploy does not rotate
credentials. An existing empty server is not a fresh target. Incompatible schemas
are not upgraded; never edit schema markers or reset data as a deployment retry.

## 4. Build the release ZIP

Build the Linux/amd64 export stage. `Plan` and `Deploy` inspect an existing
archive; they do not package it:

```powershell
$revision = (git rev-parse --short=12 HEAD).Trim()
docker buildx build --platform linux/amd64 --target export `
  --build-arg "RELEASE_REVISION=$revision" `
  --output type=local,dest=artifacts/release .
```

Output: `artifacts/release/agent-control-linux-x64.zip` (compiled assets and
production dependencies) and `.zip.sha256` sidecar. Keep both unchanged.
Builds use `https://packagefeedproxy.microsoft.io/npm/`; no host npm install.
This packages the worktree, not just HEAD: use a distinct `RELEASE_REVISION`
label for reviewed uncommitted changes and retain the exact source.

## 5. Preview the deployment

Authenticate to the target tenant/subscription, then run Plan:

```powershell
$target = Get-Content -LiteralPath $targetFile -Raw | ConvertFrom-Json
az login --tenant $target.tenantId
az account set --subscription $target.subscriptionId
pwsh ./deploy-azure.ps1 -Action Plan -TargetFile $targetFile `
  -ReceiptPath artifacts/release/azure-plan.json
```

Plan checks identity, regional availability, estimate, secrets, primary Entra
registration, target state, ZIP checksum/content and Bicep what-if. It reads
selected API secrets privately and builds/runs an inspection image, but does not
provision targets. Expect `previewed_not_deployed`; review receipt/what-if and
rerun after source/package/target/network/estimate changes. This is not a live
price quote or login test.

## 6. Deploy

Within the target's active maintenance window, use the same reviewed target and
unchanged ZIP/checksum:

```powershell
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile $targetFile `
  -ReceiptPath artifacts/release/azure-deployment.json
```

Deploy repeats preflight/what-if. Existing installations are stopped/drained and
backed up before changes. The script verifies schema/grants, deploys the ZIP,
checks runtime secrets, monitoring and contained HTTP routes, then reopens
automatically.

Expect `deployed` (or the MCP outcome below). Retain the redacted receipt, target
and ZIP/checksum. No login receipt or application-enable action is required.

## 7. Verify sign-in and first synchronization

Check the public endpoints:

```powershell
$origin = $target.canonicalOrigin.TrimEnd('/')
Invoke-RestMethod "$origin/api/health"
Invoke-RestMethod "$origin/api/ready"
```

Both should return HTTP 200 with `ok=true`. Then:

1. Open `$origin`; sign in/out with assigned Viewer, Usage Report Uploader and
   Admin test accounts. Check the [permissions reference](user-roles-and-permissions.md).
2. Keep the signed-in browser visible and online. Read-only synchronization
   starts automatically, including on an empty first installation. Check
   **Sync** for progress and **Permissions** for consent, role or provider failures.
3. Check saved inventory, users, reports and activity, including saved-data reads
   by a user without Microsoft source-read permissions.
4. Check Admin-only audit access and Uploader restrictions on published reports
   through the UI and direct APIs. Test provider changes only against an exact
   authorized target, with current Admin/Microsoft authority and the normal
   destructive-action confirmation.
5. Verify backup retention, effective network rules, alert delivery and budget.
   The script requests a notification test; confirm it actually arrives.

Deployment checks prove authentication configuration, not interactive login,
provider access or these user journeys.

## Recover a failed deployment

Inspect `failedStep`, `completedSteps`, containment/cleanup evidence and
`ownedResourcesRemaining`. Reconcile unknown writes; never edit receipts to
bypass refusal. Resume requires the same action, target, component and release:

```powershell
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile $targetFile `
  -ResumeReceiptPath artifacts/release/azure-deployment.json `
  -ReceiptPath artifacts/release/azure-resume.json
```

A changed target cannot resume an older receipt. For cleanup only:

```powershell
pwsh ./deploy-azure.ps1 -Action Cleanup -TargetFile $targetFile `
  -ResumeReceiptPath artifacts/release/azure-deployment.json `
  -ReceiptPath artifacts/release/azure-cleanup.json
```

Cleanup removes tracked temporary resources (runner firewall rule or unswitched
restore server), not serving data; it does not reopen the app. A containment
failure requires incident handling—do not assume the app is safely stopped.
Failed retries and successful temporary-resource cleanup retain the original
uncertain external-write step; neither establishes that the write can be replayed.
Before deleting a tracked restore, cleanup reads the app's current `PGHOST` and
requires it to identify the original source server. A switched, missing, ambiguous
or unavailable setting retains the restore and its ownership record for
reconciliation; an uncertain switch is never evidence that deletion is safe.
Resume verifies application containment before writes and restores the exact
runner firewall rule before rechecking the database schema.

## Operate the deployment

- Keep runtime secret references versioned and the database admin password
  operator-only; coordinate rotation separately, without falsifying version metadata.
- Monitor PostgreSQL credits/memory/storage/connections/latency and application
  readiness, HTTP failures, restarts and provider failures.
- Verify alert/budget notification delivery and review provider permissions/app roles.

Use [Operations](operations.md) for synchronization and job troubleshooting.

### Point-in-time recovery

Follow [disaster recovery](../infra/disaster-recovery.md) for the exact source,
approved UTC restore point/data loss, window, cost and rollback/cleanup owner:

```powershell
pwsh ./deploy-azure.ps1 -Action PointInTimeRestore `
  -TargetFile $targetFile -RestorePoint '<approved-UTC-timestamp>'
```

Replace the timestamp placeholder. `PointInTimeRestore` validates a temporary
isolated server, then deletes it during cleanup; it never repoints the app.
The restore name keeps up to 46 source-name characters plus the run-specific
`-restore-<eight-character-run-id>` suffix, within the 63-character server limit.
Separately authorized `-Action Recover` with that restore point creates/validates
a restore, switches serving and retains the old server. Verify scope, revoked
sessions, report selections and uncertain jobs before returning to use.
Only the current schema is supported. A reset is not a rollback: provider sync
cannot reconstruct deleted history.

## Optional independent MCP App Service

Browser operation does not require MCP. Omit `mcp` for API/web-only deployment.
To add the separate single-worker Linux S1 container App Service:

1. Follow [MCP registration steps 1–3](mcp-integration.md#1-update-the-existing-agent-control-registration)
   using `https://<mcp-site>.azurewebsites.net/mcp` and Entra callback
   `https://<mcp-site>.azurewebsites.net/auth/callback`. The Azure profile does
   not configure custom domains/proxies; skip the local wizard.
2. Prepare the immutable ACR image, separate managed identity, per-secret vault
   grants and private Blob/network resources per the
   [Azure hosting contract](mcp-reference.md#azure-hosting-profile).
   The script creates only the site/plan. State uses the prepared leased
   `oauth-state.v1.fernet` Blob, not Azure Files or PostgreSQL.
3. Add [`infra/mcp-target.example.json`](../infra/mcp-target.example.json) as the
   `mcp` object in the same version-2 target, filling every field. Include extra
   cost and, for existing sites, current digest/secret versions.
4. Preview and deploy independently:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -Component Mcp -TargetFile $targetFile `
  -ReceiptPath artifacts/release/mcp-plan.json
pwsh ./deploy-azure.ps1 -Action Deploy -Component Mcp -TargetFile $targetFile `
  -ReceiptPath artifacts/release/mcp-deployment.json
```

MCP-only operations need PowerShell, Azure CLI and Bicep, not Docker/API ZIP or
API secret values. Default `All` applies MCP after API/web opens; `Application`
refuses targets containing `mcp`. A combined MCP failure leaves API/web online
with nonzero `deployed_mcp_failed`/`recovered_mcp_failed` outcome.

For browser **MCP settings**, prepare the independent
`agent-control-mcp-metadata` secret through the existing protected-secret process.
The `secrets.metadata` reference pins the same version on both API and MCP; no
deployment step creates its value or grants secret-writing rights. The API gets
read access to this one MCP secret, never the three OAuth secrets. Missing,
malformed or unresolved metadata-only references leave business deployment and
sign-in usable and report unavailable metadata explicitly.
Malformed metadata references are omitted from generated parameters and receipts;
the exact metadata-only read grant remains permitted when its reference is
unavailable, without permitting access to any additional secret.
`network.apiInboundIpv4Addresses` must exactly equal the approved API outbound
addresses; these fixed `/32` ingress rules supplement, not replace or broaden,
the explicit client CIDRs. The API's fixed HTTPS metadata origin and expected
tenant/API/MCP/resource binding are deployed with its native reference. Offline
contract checks do not prove live Azure reference resolution or networking.

Connect an authorized [MCP client](mcp-clients.md); sign in and call
`capabilities` (`action: "list", input: {}`) and a saved-data tool. Validate OAuth/OBO/API access, effective
network/DNS, client compatibility and restart recovery—not just readiness.
Use independent
[MCP recovery procedure](../infra/disaster-recovery.md#independent-azure-mcp-recovery)
for Blob/key/lease failures, never an application database reset.

## Troubleshooting

| Problem | Check or next action |
| --- | --- |
| Target rejected | Fill placeholders; check IDs, estimate age/total, window and selected/current versions. No unsupported fields or tiers. |
| ZIP/checksum failure | Rebuild step 4; keep ZIP/original sidecar together. Never hand-edit the checksum. |
| Entra/login failure | Exact Web callback, enabled roles, Assignment required, Admin assignment and each tenant's consent |
| Vault references unresolved | RBAC/template deployment, enabled/unexpired versions, exact runtime grants; no app access to admin secret |
| Fresh resources exist or egress differs | Reconcile resources/network/receipt before supported resume. Do not relabel resources, broaden firewall rules or delete data to force retry. |
| Ready remains 503 | Inspect containment/failed step; repair via deployment/recovery. Do not clear maintenance to bypass schema, drain or secret checks. |
| No first sync | Browser visible/online; inspect Sync/Permissions for the specific consent, role, license or provider failure. No acceptance or enable switch is needed. |
| MCP failed; API/web healthy | Check MCP outcome, binding, identity, Blob lease and DNS. Reconcile uncertain ARM/Blob writes; preserve keys/state. |
