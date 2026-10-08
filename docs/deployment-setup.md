# Deployment setup

This guide configures Microsoft Entra ID and starts Agent Control locally.

## Prerequisites

- PowerShell 7
- Docker Desktop, or Docker Engine with Compose v2
- Git and a checkout of this repository
- An Entra app registration for each tenant
- An Entra administrator who can configure the app registration and grant consent

For each tenant, collect:

- tenant ID;
- application (client) ID;
- client secret value;
- accepted username domains, such as `contoso.com`.

## Configure the Entra application

Complete these steps for every tenant used by Agent Control.

### 1. Add the callback URL

In **Entra admin center > App registrations > your application >
Authentication**, add a **Web** redirect URI.

For the default local port:

```text
http://localhost:3001/api/auth/callback
```

If you use another port or deploy to Azure, register that origin followed by
`/api/auth/callback`.

### 2. Add the app roles

Import only the `appRoles` array from
[`infra/entra-app-manifest.json`](../infra/entra-app-manifest.json), or create
these roles manually:

| Role | Use |
| --- | --- |
| `AgentControl.Viewer` | View inventory, reports, and investigations |
| `AgentControl.Admin` | Viewer access plus supported changes, imports, and configuration |

The roles must be enabled and allow **Users/Groups**. Admin already includes
Viewer access, so each user or group needs only one role.

### 3. Require assignment

Open **Enterprise applications > your application > Properties** and set
**Assignment required?** to **Yes**.

Assign each approved user or group either **Agent Control Viewer** or
**Agent Control Admin**. Sign out and back in after changing assignments.

### 4. Add API permissions

Open **App registrations > your application > API permissions**. Add only the
permissions needed for the features you plan to use.

| API | Delegated permission | Feature |
| --- | --- | --- |
| Microsoft Graph / OpenID Connect | `openid`, `profile`, `offline_access` | Sign-in and session renewal |
| Microsoft Graph | `CopilotPackages.Read.All` | Package inventory |
| Microsoft Graph | `CopilotPackages.ReadWrite.All` | Package availability, assignments, block, and unblock |
| Microsoft Graph | `User.ReadBasic.All` | Basic user lookup |
| Microsoft Graph | `Group.Read.All` | Group lookup |
| Microsoft Graph | `User.Read.All` | User and license synchronization |
| Microsoft Graph | `LicenseAssignment.Read.All` | Product and service-plan catalog |
| Microsoft Graph | `Reports.Read.All` | Microsoft 365 Copilot activity |
| Microsoft Graph | `AgentIdentity.Read.All` | Copilot Studio identity matching |
| Microsoft Graph | `AuditLogsQuery.Read.All` | Purview audit search |
| Microsoft Graph | `ThreatHunting.Read.All` | Defender and Agent 365 hunting |
| Power Platform | `ResourceQuery.Resources.Read` | Copilot Studio agents and environments |
| Power Platform | `CopilotStudio.AdminActions.Invoke` | Quarantine status and changes |

The Power Platform application ID is:

```text
8578e004-a5c6-46e7-913e-12f58912df43
```

Select **Grant admin consent** after adding permissions. Agent Control does not
request these grants during sign-in.

Microsoft roles and licensing are separate from API permissions. See
[Microsoft roles and permissions](user-roles-and-permissions.md).

## Start locally

Run from the repository root:

```powershell
pwsh ./deploy-local.ps1 start
```

The first start asks for the tenant ID, client ID, client secret, accepted
domains, and local port. Configuration is saved under
`.local/agent-control/`; no `.env` file is required.

Open:

```text
http://localhost:3001
```

Use the port selected in the wizard if it differs from `3001`.

### Check permissions and collect data

After signing in:

1. Open **Permissions** and select **Check status**.
2. Resolve any missing role, permission, consent, or license.
3. Open **Sync** and refresh the sources you want to use.

## Change local settings

```powershell
pwsh ./deploy-local.ps1 edit-config
pwsh ./deploy-local.ps1 start
```

Register the new callback URL in every Entra app registration if the public URL
or port changes.

Use a separate project for an independent installation:

```powershell
pwsh ./deploy-local.ps1 start -Project contoso
```

Project state is stored under `.local/<project>/`.

## Configure multiple tenants

Add each tenant through the configuration wizard:

```powershell
pwsh ./deploy-local.ps1 edit-config
```

Each tenant needs its own app registration, client secret, accepted domains,
app-role assignments, API permissions, and admin consent. All registrations use
the same callback URL for the deployment.

Users enter their work or school username. Agent Control routes sign-in by an
exact configured domain. Domains cannot overlap and do not include subdomains
automatically.

## Use a development tunnel

1. Start Agent Control locally.
2. Create an HTTPS tunnel to the selected local port.
3. Run `pwsh ./deploy-local.ps1 edit-config` and set the tunnel URL as the public
   URL.
4. Add `<tunnel-url>/api/auth/callback` as a Web redirect URI in each Entra app
   registration.
5. Start Agent Control again.

## Run software checks

```powershell
pwsh ./deploy-local.ps1 check
```

To check and deploy the same source snapshot:

```powershell
pwsh ./deploy-local.ps1 start -ForceChecks
```

Normal `start` validates configuration and application readiness but does not
run the full test suite.

## Deploy to Azure

Production deployment uses `deploy-azure.ps1`. Follow the
[Azure deployment guide](azure-production-deployment.md).
