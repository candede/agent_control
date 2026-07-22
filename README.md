# Agent Control

Agent Control is a local Vite + Express app for Microsoft 365 admins who need to review Copilot agents, block or unblock them, and manage who can access or acquire them through Microsoft Graph Package Management APIs.

The browser talks only to the Express backend. Express handles Microsoft Entra ID sign-in, keeps the session in an httpOnly cookie, and calls Microsoft Graph on behalf of the signed-in work or school user.

## Prerequisites

- Node.js 24 or newer. The backend uses the built-in `node:sqlite` module for local audit storage.
- A Microsoft Entra app registration configured as a web app.
- Microsoft Agent 365 licensing in the tenant.
- Delegated Microsoft Graph permissions `CopilotPackages.ReadWrite.All`, `User.ReadBasic.All`, and `Group.Read.All` with admin consent.
- A work or school account with tenant permissions to manage Copilot packages.
- Optional usage enrichment requires Microsoft 365 Copilot usage report CSV exports, but it does not require any additional Microsoft Graph permissions.

The supplied Microsoft Graph docs note that block, unblock, and package access updates use `/beta` endpoints and are available only in the global cloud. Microsoft does not support beta APIs for production workloads; validate this dependency against your organization's risk policy.

The **Manage access** buttons in agent table rows and the bulk actions section are temporarily hidden because the underlying Microsoft Graph access-update endpoint is not working reliably. The buttons will remain hidden until Microsoft fixes the endpoint.

## Entra App Registration

Create an app registration in Microsoft Entra ID with these settings:

- Platform: Web
- Redirect URI: `http://localhost:3001/api/auth/callback`
- Client secret: create one and store it only in your local `.env`
- API permissions: Microsoft Graph delegated `CopilotPackages.ReadWrite.All`, `User.ReadBasic.All`, and `Group.Read.All`
- Admin consent: granted for the tenant

No additional API permission is needed for usage report import. The usage data is loaded from user-provided Microsoft 365 Copilot usage report CSV files.

## Local Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` with your tenant ID, client ID, client secret, and a long random session secret.

By default, audit events are stored in `backend/data/agent-control.sqlite`. That directory is ignored by Git so normal pulls and code updates do not overwrite local audit data. For production or Azure App Service, set `AGENT_CONTROL_DATA_DIR` to a persistent host-owned directory, such as `/home/data/agent-control`. Set `AUDIT_LOG_ENABLED=false` only if you need to disable local audit logging.

Run both apps:

```bash
npm run dev
```

Then open `http://localhost:5173`.

## Azure Deployment Automation

The repo includes a Bicep template and a cross-platform PowerShell deployment script for a first Azure production deployment:

- Frontend: Azure Static Web Apps Standard.
- Backend: single-instance Azure App Service for Linux.
- Secrets: existing Azure Key Vault secrets are referenced from App Service settings.
- Key Vault networking: public access by default, or an optional private endpoint with App Service VNet integration.
- App registration: provide an existing Microsoft Entra app registration client ID. The deployment script does not create or modify app registrations.

The Bicep file provisions Azure hosting resources and configuration. It creates the Static Web Apps resource, App Service plan, backend App Service, Application Insights, App Service settings, the Static Web Apps linked backend, and a `Key Vault Secrets User` role assignment for the backend managed identity. In private mode it also creates the virtual network, subnets, private endpoint, and private DNS resources. It does not upload frontend or backend code by itself. The `deploy-production.ps1` script runs Bicep first, validates Key Vault references, then packages and deploys the backend and uploads the built frontend.

Static Web Apps proxies linked backends only through `/api/*`, so the auth endpoints are under `/api/auth/*`. Use this production redirect URI after the Static Web Apps resource exists:

```text
https://<static-web-app-host>/api/auth/callback
```

Before production deployment, the platform or application administrator must prepare:

- An existing Microsoft Entra app registration configured as a web app.
- A production redirect URI on that app registration: `https://<static-web-app-host>/api/auth/callback`.
- Microsoft Graph delegated `CopilotPackages.ReadWrite.All`, `User.ReadBasic.All`, and `Group.Read.All` on that app registration, with tenant-wide admin consent granted.
- An existing RBAC-enabled Azure Key Vault in the deployment resource group.
- Existing Key Vault secrets for the Entra app client secret and Express session secret. The script defaults to `agent-control-client-secret` and `agent-control-session-secret`, but you can pass different secret names when running it.

### Create the production Key Vault

Create the vault in the same resource group that you will pass to `deploy-production.ps1`, then use these settings:

- **Basics**: use the deployment subscription and resource group. Standard pricing is sufficient. Enable purge protection for a production vault if it matches your organization's recovery policy; after it is enabled, it cannot be disabled.
- **Access configuration**: select **Azure role-based access control**. Leave **Azure Virtual Machines for deployment**, **Azure Resource Manager for template deployment**, and **Azure Disk Encryption for volume encryption** unchecked. Agent Control does not use those legacy resource-access options.
- **Networking**: choose the deployment mode that matches your organization's policy.

| Mode    | Script parameter                                      | Key Vault configuration                                             | Additional resources                                                                               |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Public  | `-KeyVaultNetworkAccess Public` or omit the parameter | Public access enabled from all networks                             | None                                                                                               |
| Private | `-KeyVaultNetworkAccess Private`                      | Public access disabled by the script after private resources deploy | VNet, two subnets, private endpoint, private DNS zone, VNet link, and App Service VNet integration |

Public mode is the backward-compatible default. Public reachability does not make secrets anonymous: Microsoft Entra authentication and Key Vault RBAC are still required. Private mode adds network isolation so the Key Vault data-plane endpoint is reachable by the application through the VNet and private endpoint. It has a small additional Azure cost for the private endpoint and Private DNS usage.

Private mode uses `10.42.0.0/24` by default, with `10.42.0.0/26` delegated to App Service and `10.42.0.64/27` used for private endpoints. Override all three prefixes when those ranges conflict with connected or peered networks. The subnets must be contained by the VNet address space and must not overlap.

Organizational Azure Policy may force Key Vault public access to remain disabled. Use private mode in that environment. Tenant-specific policy exemptions or bypass tags are not created, removed, or relied upon by this repository.

After the vault is created:

1. Give the administrator who will add the secret values a data-plane role such as **Key Vault Secrets Officer** on the vault. Creating the vault or having resource deployment permissions does not necessarily grant permission to create secrets when Azure RBAC is selected.
2. Under **Objects** > **Secrets**, create `agent-control-client-secret`. Use the Entra app registration client secret **Value**, not its Secret ID.
3. Create `agent-control-session-secret` with a separate cryptographically random value. A generated value of at least 32 random bytes is appropriate; do not reuse the Entra client secret. Generate a Base64-encoded value on macOS, Linux, WSL, or Git Bash with OpenSSL installed:

   ```bash
   openssl rand -base64 32
   ```

   On native Windows, use PowerShell 7 (`pwsh`):

   ```powershell
   [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
   ```

   Store the command output as the Key Vault secret value.

4. Keep both secrets enabled. The deployment script references the latest enabled version because the Bicep references do not pin a secret version.

You do not need to grant the future App Service access manually. During deployment, Bicep enables its system-assigned managed identity and assigns that identity the least-privilege **Key Vault Secrets User** role on this vault.

### Recommended deployment: PowerShell script

Use `deploy-production.ps1` for normal deployments. It works from Windows, macOS, or Linux with PowerShell 7, Azure CLI, and Node.js 24 or newer installed. It opens the Azure browser sign-in flow if you are not already signed in, validates the app, runs Bicep, deploys the backend App Service package, deploys the Static Web Apps frontend, and smoke-tests `/api/health`.

1. Prepare the Azure and Entra prerequisites.

   Confirm that the Entra app registration already exists. For a new production deployment, create the target Azure resource group first, then create an RBAC-enabled Key Vault in that resource group with secrets for the Entra app client secret and Express session secret. The deployment script defaults to `agent-control-client-secret` and `agent-control-session-secret`. It does not create the vault or write secrets; it expects the vault to exist in the same resource group that you pass to the script.

2. Install local deployment tools.

   Install these tools on the machine where you will run the deployment:
   - PowerShell 7 or newer: https://learn.microsoft.com/powershell/scripting/install/installing-powershell
   - Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli
   - Node.js 24 or newer: https://nodejs.org/

3. Download or clone this repository.

   You do not need a GitHub account to deploy. Download the repository as a ZIP file, or clone it if you already use Git. Open a terminal in the repository root folder.

4. Confirm your Azure permissions.

   The account that runs the script needs permission to deploy into the target resource group and grant the backend App Service managed identity `Key Vault Secrets User` on the existing vault, such as Owner or User Access Administrator at the vault or resource-group scope. Private mode also requires permission to create virtual network, private endpoint, and private DNS resources and to disable public network access on the existing vault. The script does not need permissions to create Key Vaults, write Key Vault secrets, create app registrations, change app registration redirect URIs, add Graph permissions, or grant tenant-wide admin consent.

5. Run the deployment script.

   The script prompts for any missing values. To provide all values up front, run:

   `NamePrefix` is used to generate Azure resource names, such as `<prefix>-prod-swa` and `<prefix>-prod-api`. The script defaults to `agent-control`, so you can omit `-NamePrefix` for a simple first deployment. If Azure reports a resource-name collision, or if your organization requires a naming convention, rerun the script with a short lowercase prefix such as `<org>-agent-control`.

   `Location` defaults to the Azure region of the target resource group and controls the backend App Service, App Service plan, and Application Insights. `StaticWebAppLocation` is independent and defaults to `westeurope`, one of the regions supported by Azure Static Web Apps. The template does not create an Azure Function App; the Static Web Apps resource still requires its own supported location even though staging environments are disabled and the backend is a linked App Service.

   Azure validates App Service worker quota during the Bicep deployment preflight. If the subscription does not have enough B1 quota in `Location`, the script stops with region-specific `az quota` commands and the minimum limit reported by Azure. It does not request quota automatically: quota changes require subscription-level permissions, may be governed centrally, and can require Azure approval. Quota allocation is free, but the App Service plan created after approval is billable.

   On the first deployment, App Service can briefly start before ZipDeploy has populated `/home/site/wwwroot`. Azure CLI's Linux startup tracker may retain that empty-site failure even after OneDeploy succeeds and the packaged backend starts. Kudu can also recycle while handling a synchronous deployment request and return a transient 502 after accepting the ZIP. The script submits ZipDeploy asynchronously, retries only transient 502/503/504 submission failures, and polls Kudu's deployment record for up to 15 minutes. After Kudu reports success, it deploys the frontend and retries `https://<static-web-app-host>/api/health` for up to 10 minutes. The health check must return `{ "ok": true }` before deployment is reported as complete.

   Frontend deployment does not change or override npm configuration. The script reads Microsoft's stable native `StaticSitesClient` release metadata from `https://aka.ms/swalocaldeploy`, downloads the platform binary from the published Azure Front Door URL, verifies its SHA-256 checksum, and caches it in the operating system's temporary directory by build ID. The Static Web Apps deployment token is passed through a temporary process environment variable and is removed or restored immediately afterward; it is never included in the command line or deployment exception text.

   The linked backend enables App Service Authentication for the Azure Static Web Apps provider. A direct request to `https://<backend-app>.azurewebsites.net/api/health` returning `401` is expected; use the Static Web Apps URL to test the application. This prevents callers from bypassing the frontend route to access the backend directly.

   ```powershell
   pwsh ./deploy-production.ps1 `
      -SubscriptionId "<subscription-id>" `
      -TenantId "<tenant-id>" `
      -ResourceGroupName "<resource-group-name>" `
      -EnvironmentName "prod" `
      -AppRegistrationClientId "<existing-entra-app-client-id>" `
      -KeyVaultName "<existing-key-vault-name>" `
      -ClientSecretName "agent-control-client-secret" `
      -SessionSecretName "agent-control-session-secret"
   ```

   For private Key Vault access, add:

   ```powershell
   -KeyVaultNetworkAccess Private
   ```

   To override the dedicated network ranges, also pass `-VirtualNetworkAddressPrefix`, `-AppServiceIntegrationSubnetPrefix`, and `-PrivateEndpointSubnetPrefix`. The script creates the private network path first, disables the vault public endpoint, and then requires both App Service Key Vault references to report `Resolved` before application deployment continues.

   On Windows PowerShell 7, use the same command from the repository root. If your shell starts in Windows PowerShell 5.1, run `pwsh` first or launch **PowerShell 7** from the Start menu.

6. Confirm the production redirect URI.

   After the first run, the script prints the Static Web Apps URL and expected Entra redirect URI. Add this redirect URI to the existing Entra app registration if it is not already present:

   ```text
   https://<static-web-app-host>/api/auth/callback
   ```

7. Rerun and test.

   Rerun the script so the deployed backend `REDIRECT_URI` and the Entra app registration match before testing sign-in. Open the Static Web Apps URL and sign in with an admin account that can manage Copilot packages.

### Direct Bicep deployment: infrastructure only

Use Bicep directly only when you want to create or update Azure hosting resources without deploying application code. This is useful for platform teams that validate infrastructure separately from app release automation.

```bash
az login
az account set --subscription <subscription-id>

az group create \
   --name <resource-group-name> \
   --location <azure-region>

az deployment group create \
   --resource-group <resource-group-name> \
   --template-file infra/main.bicep \
   --parameters \
      environmentName=<dev|test|prod> \
      location=<azure-region> \
      staticWebAppLocation=<static-web-apps-region> \
      namePrefix=<globally-unique-prefix> \
      tenantId=<tenant-id> \
      appRegistrationClientId=<existing-entra-app-client-id> \
      keyVaultName=<existing-key-vault-name> \
      keyVaultNetworkAccess=<Public|Private> \
      clientSecretName=<client-secret-name> \
      sessionSecretName=<session-secret-name>
```

When using direct Bicep deployment with `keyVaultNetworkAccess=Private`, Bicep creates the private network path but does not modify the existing Key Vault resource. After the deployment succeeds, disable its public endpoint with `az keyvault update --public-network-access Disabled`, refresh the App Service Key Vault references, and confirm both report `Resolved`. The PowerShell deployment script performs these steps automatically.

You can also copy or edit [infra/main.bicepparam](infra/main.bicepparam) and pass it instead of inline parameters:

```bash
az deployment group create \
   --resource-group <resource-group-name> \
   --template-file infra/main.bicep \
   --parameters infra/main.bicepparam
```

The Bicep deployment outputs `staticWebAppName`, `staticWebAppUrl`, `backendAppName`, `backendAppResourceId`, `backendAppUrl`, `redirectUri`, and `keyVaultNetworkAccess`. It does not deploy `frontend/dist` or `backend/dist`.

If you deploy code manually after running Bicep, build first:

```bash
npm ci
npm run test --workspace backend
npm run test --workspace frontend
npm run typecheck --workspace backend
npm run lint --workspace frontend
npm run build
```

Package and deploy the backend:

```bash
rm -rf backend-package backend.zip
mkdir -p backend-package/backend backend-package/frontend
cp package-lock.json package.json backend-package/
cp backend/package.json backend-package/backend/package.json
cp frontend/package.json backend-package/frontend/package.json
cp -R backend/dist backend-package/backend/dist
(cd backend-package && npm ci --omit=dev --workspace backend)
rm -rf backend-package/frontend
(cd backend-package && zip -qr ../backend.zip .)

az webapp deploy \
   --resource-group <resource-group-name> \
   --name <backendAppName-output> \
   --src-path backend.zip \
   --type zip
```

For production frontend deployment, use `deploy-production.ps1` rather than invoking the npm-distributed Static Web Apps CLI manually. The script performs the frontend build and uploads `frontend/dist` with the checksum-verified native client described above.

The backend keeps the current SQLite audit log for this first deployment. It is configured to write under `/home/data/agent-control`, which is persistent App Service storage. Keep the App Service scaled to one instance unless you move audit logging and session state to shared Azure services.

## Usage Report Import

Agent Control works without report files. If no usage reports are imported, the app lists Copilot packages and supports block/unblock exactly as before.

To enrich the package list and user access view with last activity, active users, responses sent, creator type, and user drilldown data:

1. Obtain these three Microsoft 365 Copilot usage report CSV exports for the same period, typically 30 days:
   - **Agents**: agent-level metrics used for Agent view enrichment and inactive-agent filtering.
   - **Users & agents**: per-user, per-agent rows used by agent details and User view access history.
   - **Users**: user-level summary rows used by User view summary metrics.
2. In Agent Control, use **Import CSVs** and select one, two, or all three exported CSV files.

The app has two primary views. **Agent view** lists current Copilot packages from the Graph package API, enriched with imported report data when available. **User view** starts with users, then shows every agent access row found for the selected user in the **Users & agents** CSV. The User view combines the **Users** CSV with bridge-only usernames from the **Users & agents** CSV so a user is not hidden just because they are missing from one export.

The **Agents** CSV is the canonical source for agent-level metrics. The **Users & agents** CSV is used for drilldown, User view access history, and as a fallback if the Agents CSV has not been imported. The **Users** CSV is used for user summary context.

The app matches imported report rows to listed packages by `Agent ID`. Report-only rows that do not match a package are shown as unmatched diagnostics and are not blockable. Package rows without imported report data remain visible and manageable.

The inactive filter uses **Last activity date (UTC)** from the imported report. Active user and response counts belong to the selected report period, so an agent can have `0` responses in a 30-day export while still having a known older last activity date. User view includes `0`-response **Users & agents** rows as access history by default and separately shows response-producing agent counts.

## Useful Commands

```bash
npm run build
npm run test
npm run lint
npm run dev --workspace backend
npm run dev --workspace frontend
```

## API Behavior

- `GET /api/agents` lists packages filtered to `supportedHosts` containing `Copilot`.
- `GET /api/agents/:id` gets package details.
- `PATCH /api/agents/:id/access` replaces one package's Available to or Installed for collection.
- `POST /api/agents/access` starts a bulk Add or Replace access job for selected packages.
- `GET /api/directory/principals` searches users, security groups, and Microsoft 365 groups.
- `POST /api/directory/principals/resolve` resolves package assignment IDs for display.
- `GET /api/agents/bulk-jobs/:id` returns progress and results for a bulk job.
- `POST /api/agents/block` starts a selected-ID bulk block job.
- `POST /api/agents/unblock` starts a selected-ID bulk unblock job.
- `POST /api/agents/:id/block` blocks one package.
- `POST /api/agents/:id/unblock` unblocks one package.
- `POST /api/agents/block-all` blocks all currently listed unblocked agents.
- `POST /api/agents/unblock-all` unblocks all currently listed blocked agents.
- `GET /api/audit/events` lists persisted block, unblock, availability, and installation audit events.
- `GET /api/auth/login`, `GET /api/auth/callback`, and `POST /api/auth/logout` handle sign-in and sign-out.

Usage report import is handled in the browser from local CSV files. It does not add backend report endpoints and does not call Microsoft Graph for report data.

Bulk actions are best effort. The backend returns succeeded, skipped, and failed entries so partial failures are visible. Access **Add** reads each package, merges and deduplicates the selected principals, and skips packages that already contain them. It also skips an all-user scope because the selected principals already have access, and fails safely when Graph does not return enough information to distinguish an empty scope from a broad one. To match the documented beta API example, each PATCH sends both writable collections: the selected collection is changed and the other collection is preserved from the package detail response. If Graph omits the unselected collection, the app refuses the write rather than risk clearing it.

After Graph returns `204 No Content` for an access PATCH, Agent Control reads the package again, verifies the requested effective `all`/`some`/`none` scope and principal collection, and confirms that the unselected access setting was preserved. Graph can accept a collection update without changing an existing All users scope. In that case, Agent Control reports `access_update_not_applied`, keeps the editor open, and records a failed audit event instead of claiming success. The documented API does not provide a writable `availableTo` or `deployedTo` property to force that scope transition.

The access editor supports individual users, security groups, Microsoft 365 groups, and clearing a collection with **No users**. Microsoft Graph reports `all`, `some`, or `none` through `availableTo` and `deployedTo`, but the update API documents only the user/group collections as writable. **All users** remains disabled because Microsoft does not document a supported write payload; the app does not substitute a tenant-wide group for that state.

## Audit Log

The backend records block, unblock, availability, and installation attempts before sending the corresponding Graph mutation. Each audit event includes the agent ID, optional display name when available, action, signed-in actor, tenant ID, timestamps, final status, and failure message when Graph rejects the change. Access events also record the target, mutation mode, scope, principals, and principal counts before and after the change.

Signed-in users can review these records in the **Audit log** tab. The tab loads the newest events from `GET /api/audit/events`, supports refresh, and filters by action, result, agent, user, or operation ID.

The audit log is a local SQLite database. This keeps development and a first Azure deployment simple, but it assumes a single writable backend instance. For Azure production usage with this storage mode, deploy the backend as a single-instance App Service and point `AGENT_CONTROL_DATA_DIR` at persistent App Service storage under `/home`. If you later need backend scale-out, multiple container replicas, or stronger compliance retention, move the audit service to Azure Table Storage or append blobs instead of sharing one SQLite file across instances.

The default `backend/data/` location survives normal `git pull` operations because it is ignored by Git. It will not survive deployment processes that delete the entire repository directory, so use an outside-repo or Azure persistent path for anything important.

## Disclaimer

This project is provided as-is, without warranty of any kind. Use it at your own discretion and validate it in your own environment before relying on it for administrative workflows.

For more information, visit https://candede.com.
