# Azure production deployment

Deploy Agent Control to Linux App Service with PostgreSQL Flexible Server using
`deploy-azure.ps1`. The deployment requires a prepared Key Vault and an approved
target file; these deployment records are not application login or sync gates.

## Requirements

- Git, PowerShell 7, Docker with Buildx, and Azure CLI.
- Standalone [Bicep CLI](https://learn.microsoft.com/azure/azure-resource-manager/bicep/install#install-manually).
- An existing resource group, prepared Key Vault and monitoring action group.
- Deployment and role-assignment permissions for the exact target resources.
- Permission to read the selected Key Vault secret versions and use Key Vault
  template deployment.
- Access to review every configured tenant's Entra registration, assignments
  and admin consent.
- Approved exact App Service outbound addresses and temporary runner IPv4
  firewall access to PostgreSQL.

Complete [Entra setup](deployment-setup.md#configure-the-entra-application).
Every tenant registration must use the production callback:

```text
https://<app-host>/api/auth/callback
```

Use the [permissions reference](user-roles-and-permissions.md) for app roles and
Microsoft permissions; do not add deployment-specific user permissions.

## Supported deployment profile

The scripts and templates enforce this profile:

| Resource | Supported configuration |
| --- | --- |
| App Service | One Linux Basic B1 instance; Node 24; remote build disabled |
| PostgreSQL | Version 17, `Standard_B1ms`, Burstable, 32 GiB |
| Database availability | Seven-day backup retention; no HA or replicas |
| Application pool | Maximum four connections |
| Monitoring | 30-day retention; 0.1 GiB daily ingestion cap; existing action group |

Other tiers and sizes require corresponding template and deployment-tool
changes, not just a revised approval file. Review
[PostgreSQL compute limitations](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-compute)
against the expected workload and budget before choosing this profile.

## Prepare Key Vault

The prepared vault must contain these exact secret names with selected versions:

| Secret name | Consumer |
| --- | --- |
| `agent-control-tenants-json` | Application tenant registry |
| `agent-control-session-secret` | Application sessions |
| `agent-control-postgres-admin-password` | Database operator only |
| `agent-control-postgres-app-password` | Application database role |

Only the three rows other than `agent-control-postgres-admin-password` are
provided to the application runtime, as `TENANTS_JSON`, `SESSION_SECRET` and
`PGPASSWORD`. The administrator password must not appear in runtime settings or
be readable by the application's identity.

The registry contains each tenant's ID, application client ID, client secret,
accepted domains and optional display name. Keep secret values out of source
control, command arguments, target files, receipts and logs.

## Build the release ZIP

Run from the repository root. Build the Linux/amd64 export stage; `Plan` and
`Deploy` inspect an existing archive rather than producing it:

```powershell
$revision = (git rev-parse --short=12 HEAD).Trim()
docker buildx build --platform linux/amd64 --target export `
  --build-arg "RELEASE_REVISION=$revision" `
  --output type=local,dest=artifacts/release .
```

The output contains:

- `artifacts/release/agent-control-linux-x64.zip`
- `artifacts/release/agent-control-linux-x64.zip.sha256`

The ZIP includes compiled backend/frontend assets and production dependencies.
Keep both files together and do not edit the archive after packaging. Builds
use the approved npm feed configured in the Dockerfile; no host npm install is
required.

Record the exact source used. This command packages the current worktree, not
only the named commit; use a distinct reviewed revision label if the worktree
differs from that commit.

## Prepare the approval file

Copy [`infra/production-target.example.json`](../infra/production-target.example.json)
to an access-restricted location outside source control. Complete:

- `isApproval=true`, tenant/subscription/resource-group/region identities.
- Entra application, canonical HTTPS origin, exact callback and tenant-registry
  registration approval reference.
- Resource names and matching expected IDs, database name, exact outbound
  addresses and runner IPv4.
- All four selected Key Vault versions; for an existing installation, also
  supply all four currently deployed versions. Selected and deployed versions
  must match; this owner does not perform credential rotation.
- Dated, itemized monthly estimate, budget, operator approval and a maintenance
  window no longer than eight hours.
- The profile's explicit Burstable risk acceptance and monitoring/action-group
  details.

Choose the installation mode:

| Mode | Required target state |
| --- | --- |
| `fresh` | App Service, plan and PostgreSQL target resources do not yet exist; set `firstInstallApproved=true`. Initialization requires an empty database. |
| `existing` | Exact target resources exist and the database already uses the current application schema; set `firstInstallApproved=false`. |

An existing empty server is not a fresh target under this owner. An incompatible
schema is not upgraded automatically. Do not edit schema markers or use a
destructive reset as a deployment retry.

## Preview the deployment

Authenticate Azure CLI to the target tenant and subscription, then run:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -TargetFile <approved-target.json> `
  -ReceiptPath artifacts/release/azure-plan.json
```

Plan validates identity, the fixed resource profile, pricing, secret references,
Entra configuration, release checksum/content and Bicep what-if.
It queries Azure and builds an inspection image locally; it does not provision
the target or change Entra roles, grants or consent.

Review the redacted output. Resolve failures and rerun Plan whenever source,
target, network or estimate changes.

## Deploy

Use the same reviewed target and unchanged release ZIP:

```powershell
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile <approved-target.json> `
  -ReceiptPath artifacts/release/azure-deployment.json
```

Deploy repeats preflight and what-if, then performs the authorized changes
within the maintenance window. For existing installations it drains the app
and verifies a managed backup before applying changes.

The owner verifies current schema/grants, deploys the ZIP, resolves runtime
secret references and checks monitoring and contained HTTP routes. It reopens
the app automatically after those checks pass. No login receipt, release
acceptance or application-enable action is required.

Retain the redacted receipt and release ZIP/checksum for troubleshooting.
Deployment checks verify authentication configuration, not interactive login.

## Verify the release

After deployment:

1. Check `/api/health` and `/api/ready`.
2. Sign in and out using assigned test accounts. Verify Viewer, Uploader and
   Admin behavior against the [permissions reference](user-roles-and-permissions.md).
3. Confirm automatic read-only synchronization starts while visible and online.
   Use **Sync** for progress and **Permissions** for actual provider failures.
4. Verify shared saved inventory, users, reports and activity, including access
   by a user without Microsoft source-read permissions.
5. Check Admin-only audit access and Uploader restrictions on published reports
   through both the UI and direct APIs.
6. Test provider changes only with an exact reviewed target, current Admin and
   Microsoft authority, and the normal destructive-action confirmation.
7. Verify backup retention, effective network rules, alert delivery and budget.

Health and software tests alone do not prove provider access or these journeys.

## Recover a failed deployment

Read the receipt's failed step, completed steps, containment and cleanup outcome.
If an external write has an unknown outcome, reconcile the exact resource,
deployment, package or database state before any retry.

For a supported resumable failure, keep the same target, component and release:

```powershell
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile <approved-target.json> `
  -ResumeReceiptPath <failed-receipt.json> `
  -ReceiptPath artifacts/release/azure-resume.json
```

Resume refuses uncertain external-write phases rather than blindly replaying
them. Do not alter receipts to bypass that refusal.

If only run-owned cleanup remains, use the same failed receipt:

```powershell
pwsh ./deploy-azure.ps1 -Action Cleanup -TargetFile <approved-target.json> `
  -ResumeReceiptPath <failed-receipt.json> `
  -ReceiptPath artifacts/release/azure-cleanup.json
```

Cleanup removes only tracked temporary resources. A containment failure requires
operator incident handling; do not assume the app is safely stopped.

## Operate the deployment

- Keep Key Vault references versioned and the database administrator password
  operator-only.
- Coordinate credential rotation separately with the credential owners. The
  current deployment owner rejects selected/deployed version differences on
  existing installations; Plan/Deploy is not a rotation procedure. Do not
  falsify deployed-version metadata to bypass that check.
- Monitor PostgreSQL CPU credits, memory, storage, connections and query latency.
- Check application readiness, HTTP failures, restarts and provider failures.
- Verify alert delivery and budget notifications; configured alerts are not
  proof that notifications arrived.
- Keep provider permissions and app-role assignments limited to intended users.

Use [Operations](operations.md) for synchronization and job troubleshooting.

### Point-in-time recovery

Use the [disaster recovery procedure](../infra/disaster-recovery.md) to select
the exact source, restore point, expected data loss and cleanup owner:

```powershell
pwsh ./deploy-azure.ps1 -Action PointInTimeRestore `
  -TargetFile <approved-target.json> -RestorePoint <approved-UTC-timestamp>
```

This creates an isolated review server without repointing the app.
`-Action Recover` switches serving to a verified restored server and requires
separate authorization for that switch and its data loss. Verify scope, revoked
sessions, report selections and uncertain jobs before returning to use.

## Optional independent MCP App Service

Browser operation does not require MCP. Use
[MCP integration](mcp-integration.md) for its registration, configuration,
image, storage, backup and recovery contracts, and
[MCP client setup](mcp-clients.md) for connections.

The target's optional `mcp` object uses
[`infra/mcp-target.example.json`](../infra/mcp-target.example.json) as a fragment,
not a separate target file. Omit it for API/web-only deployment.

### Prepared identities, storage and network

Before selecting the MCP profile, prepare:

- A reviewed immutable ACR image digest and separate user-assigned identity.
- The exact registry pull and per-secret Key Vault permissions.
- One `StorageV2` Standard_LRS/ZRS account, private container and prepared
  `oauth-state.v1.fernet` Block Blob, with the exact object-conditioned grant.
- The Blob private endpoint, private DNS and delegated integration subnet.
- Exact HTTPS resource/callback URLs, ingress rules and outbound reachability
  to Entra, the API, Key Vault and ACR.

There is no Azure Files or premium file-share prerequisite. The runtime uses
the leased encrypted Blob, not a filesystem mount or PostgreSQL.
The deployment owner creates the separate single-worker Linux S1 plan/site;
it does not prepare registry, identity, network or Blob resources.
Use the integration guide for exact binding, lease and recovery requirements.

For an independent MCP change:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -Component Mcp -TargetFile <approved-target.json>
pwsh ./deploy-azure.ps1 -Action Deploy -Component Mcp -TargetFile <approved-target.json>
```

MCP-only deployment needs Azure CLI and Bicep, not Docker or the API ZIP.
`All` is the default component and applies MCP after API/web is open.
`Application` requires a target without `mcp`; it cannot ignore supplied settings.
MCP failure leaves API/web online and returns a nonzero partial outcome.

### Transport and proof boundaries

Readiness and discovery do not verify authenticated OAuth/OBO/API access,
effective private DNS/network rules, client compatibility or restart recovery.
Validate those journeys with authorized accounts on the intended target.
Never use an MCP failure as a reason to reset the application database.
