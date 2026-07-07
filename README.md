# Agent Control

Agent Control is a local Vite + Express app for Microsoft 365 admins who need to review Copilot agents in a tenant and block or unblock them through Microsoft Graph Package Management APIs.

The browser talks only to the Express backend. Express handles Microsoft Entra ID sign-in, keeps the session in an httpOnly cookie, and calls Microsoft Graph on behalf of the signed-in work or school user.

## Prerequisites

- Node.js 24 or newer. The backend uses the built-in `node:sqlite` module for local audit storage.
- A Microsoft Entra app registration configured as a web app.
- Microsoft Agent 365 licensing in the tenant.
- Delegated Microsoft Graph permission `CopilotPackages.ReadWrite.All` with admin consent.
- A work or school account with tenant permissions to manage Copilot packages.
- Optional usage enrichment requires access to export Microsoft 365 admin center usage reports, but it does not require any additional Microsoft Graph permissions.

The supplied Microsoft Graph docs note that block and unblock use `/beta` endpoints and are available only in the global cloud.

## Entra App Registration

Create an app registration in Microsoft Entra ID with these settings:

- Platform: Web
- Redirect URI: `http://localhost:3001/api/auth/callback`
- Client secret: create one and store it only in your local `.env`
- API permissions: Microsoft Graph delegated `CopilotPackages.ReadWrite.All`
- Admin consent: granted for the tenant

No additional API permission is needed for usage report import. The usage data is loaded from CSV files that an admin manually exports from the Microsoft 365 admin center.

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
- App registration: provide an existing Microsoft Entra app registration client ID. The deployment script does not create or modify app registrations.

The Bicep file provisions Azure hosting resources and configuration. It creates the Static Web Apps resource, App Service plan, backend App Service, Application Insights, App Service settings, the Static Web Apps linked backend, and a `Key Vault Secrets User` role assignment for the backend managed identity. It does not upload frontend or backend code by itself. The `deploy-production.ps1` script runs Bicep first, then packages and deploys the backend and uploads the built frontend.

Static Web Apps proxies linked backends only through `/api/*`, so the auth endpoints are under `/api/auth/*`. Use this production redirect URI after the Static Web Apps resource exists:

```text
https://<static-web-app-host>/api/auth/callback
```

Before production deployment, the platform or application administrator must prepare:

- An existing Microsoft Entra app registration configured as a web app.
- A production redirect URI on that app registration: `https://<static-web-app-host>/api/auth/callback`.
- Microsoft Graph delegated `CopilotPackages.ReadWrite.All` on that app registration, with tenant-wide admin consent granted.
- An existing RBAC-enabled Azure Key Vault in the deployment resource group.
- Existing Key Vault secrets for the Entra app client secret and Express session secret. The script defaults to `agent-control-client-secret` and `agent-control-session-secret`, but you can pass different secret names when running it.

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

   The account that runs the script needs permission to deploy into the target resource group and grant the backend App Service managed identity `Key Vault Secrets User` on the existing vault, such as Owner or User Access Administrator at the vault or resource-group scope. It does not need permissions to create Key Vaults, write Key Vault secrets, create app registrations, change app registration redirect URIs, add Graph permissions, or grant tenant-wide admin consent.

5. Run the deployment script.

   The script prompts for any missing values. To provide all values up front, run:

   `NamePrefix` is used to generate Azure resource names, such as `<prefix>-prod-swa` and `<prefix>-prod-api`. The script defaults to `agent-control`, so you can omit `-NamePrefix` for a simple first deployment. If Azure reports a resource-name collision, or if your organization requires a naming convention, rerun the script with a short lowercase prefix such as `<org>-agent-control`.

   `Location` defaults to the Azure region of the target resource group. Omit `-Location` unless you need the app resources in a different supported Azure region.

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
      namePrefix=<globally-unique-prefix> \
      tenantId=<tenant-id> \
      appRegistrationClientId=<existing-entra-app-client-id> \
      keyVaultName=<existing-key-vault-name> \
      clientSecretName=<client-secret-name> \
      sessionSecretName=<session-secret-name>
```

You can also copy or edit [infra/main.bicepparam](infra/main.bicepparam) and pass it instead of inline parameters:

```bash
az deployment group create \
   --resource-group <resource-group-name> \
   --template-file infra/main.bicep \
   --parameters infra/main.bicepparam
```

The Bicep deployment outputs `staticWebAppName`, `staticWebAppUrl`, `backendAppName`, `backendAppUrl`, and `redirectUri`. It does not deploy `frontend/dist` or `backend/dist`.

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

Deploy the frontend to Static Web Apps:

```bash
SWA_DEPLOYMENT_TOKEN="$(az staticwebapp secrets list \
   --name <staticWebAppName-output> \
   --resource-group <resource-group-name> \
   --query properties.apiKey \
   -o tsv)"

npx @azure/static-web-apps-cli deploy frontend/dist \
   --deployment-token "$SWA_DEPLOYMENT_TOKEN" \
   --env production
```

The backend keeps the current SQLite audit log for this first deployment. It is configured to write under `/home/data/agent-control`, which is persistent App Service storage. Keep the App Service scaled to one instance unless you move audit logging and session state to shared Azure services.

## Usage Report Import

Agent Control works without report files. If no usage reports are imported, the app lists Copilot packages and supports block/unblock exactly as before.

To enrich the package list and user access view with last activity, active users, responses sent, creator type, and user drilldown data:

1. Go to `https://admin.microsoft.com`.
2. Open **Reports** > **Usage**.
3. Select **Microsoft 365 Copilot**.
4. Open the **Agents** report.
5. Export these three report tabs for the same period, typically 30 days:
   - **Agents**: agent-level metrics used for Agent view enrichment and inactive-agent filtering.
   - **Users & agents**: per-user, per-agent rows used by agent details and User view access history.
   - **Users**: user-level summary rows used by User view summary metrics.
6. In Agent Control, use **Import CSVs** and select one, two, or all three exported CSV files.

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
- `POST /api/agents/:id/block` blocks one package.
- `POST /api/agents/:id/unblock` unblocks one package.
- `POST /api/agents/block-all` blocks all currently listed unblocked agents.
- `POST /api/agents/unblock-all` unblocks all currently listed blocked agents.
- `GET /api/audit/events` lists persisted block/unblock audit events for the signed-in session.
- `GET /api/auth/login`, `GET /api/auth/callback`, and `POST /api/auth/logout` handle sign-in and sign-out.

Usage report import is handled in the browser from local CSV files. It does not add backend report endpoints and does not call Microsoft Graph for report data.

Bulk actions are best effort. The backend skips packages already in the requested state and returns succeeded, skipped, and failed entries so partial failures are visible.

## Audit Log

The backend records block and unblock attempts at the route boundary before calling Microsoft Graph. Each audit event includes the agent ID, optional display name when available, action, target blocked state, signed-in actor, tenant ID, timestamps, final status, and failure message when Graph rejects the change.

Signed-in users can review these records in the **Audit log** tab. The tab loads the newest events from `GET /api/audit/events`, supports refresh, and filters by action, result, agent, user, or operation ID.

The audit log is a local SQLite database. This keeps development and a first Azure deployment simple, but it assumes a single writable backend instance. For Azure production usage with this storage mode, deploy the backend as a single-instance App Service and point `AGENT_CONTROL_DATA_DIR` at persistent App Service storage under `/home`. If you later need backend scale-out, multiple container replicas, or stronger compliance retention, move the audit service to Azure Table Storage or append blobs instead of sharing one SQLite file across instances.

The default `backend/data/` location survives normal `git pull` operations because it is ignored by Git. It will not survive deployment processes that delete the entire repository directory, so use an outside-repo or Azure persistent path for anything important.

## Disclaimer

This project is provided as-is, without warranty of any kind. Use it at your own discretion and validate it in your own environment before relying on it for administrative workflows.

For more information, visit https://candede.com.
