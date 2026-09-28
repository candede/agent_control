# Agent Control

Discover and manage Microsoft 365 and Copilot Studio agents from one dashboard.

- Browse agents, owners, environments, and access assignments.
- Track Copilot licenses, adoption, and agent usage.
- Block or unblock packages, change access, and quarantine Studio agents.
- Investigate activity with Microsoft Purview and Defender.

Built with React, Express, Microsoft Graph, Power Platform, and PostgreSQL.

## Quick start

### 1. Get the project

```bash
git clone https://github.com/candede/agent_control.git
cd agent_control
```

Install **PowerShell 7** and start **Docker Desktop** (or Docker Engine with Compose v2). Node.js and PostgreSQL run in containers; no host Node.js installation is needed.

### 2. Set up Microsoft sign-in

Follow the [Entra setup guide](docs/deployment-setup.md#entra-application) to configure the app registration, user assignments, API permissions, and admin consent.

Use this **Web redirect URI** for the default local port:

```text
http://localhost:3001/api/auth/callback
```

Have your **tenant ID**, **client ID**, **client secret value**, and **accepted username domains** (for example, `contoso.com`) ready for the setup wizard.

Microsoft Agent 365 licensing is required for the Copilot package APIs. See [Microsoft roles by action](docs/user-roles-and-permissions.md) for feature-specific access.

### 3. Start the app

```powershell
pwsh ./deploy-local.ps1 start
```

This builds and starts the app with PostgreSQL after automated checks. A first-run wizard collects your settings and port; saved configuration lives in `.local/agent-control/`. No `.env` file is needed.

Open **[http://localhost:3001](http://localhost:3001)** and sign in with your work or school account. If you choose another port, update the redirect URI and use that port in the browser.

## Using the app

Start with **Permissions** to check access, then **Sync** to collect your first inventory.

| Page | What to do |
| --- | --- |
| **Agents** | Search agents, inspect details and usage, manage access, and investigate activity. |
| **Users** | Review Copilot licenses, activity, and agent relationships. |
| **Sync** | Refresh source data, import usage CSVs, and review sync history. |
| **Audit** | Review administrative actions performed through this app. |
| **Permissions** | Check access and find the Microsoft roles, API permissions, and log setup you need. |

Inventory and user data refresh automatically while you are signed in and the app is active. For agent usage reports, export **Agents**, **Users & agents**, and **Users** CSVs for the same period from Microsoft 365, then choose **Sync > Add CSV reports**. See the [import guide](docs/official-usage-import.md).

## Common commands

```powershell
pwsh ./deploy-local.ps1 start        # Start or update
pwsh ./deploy-local.ps1 stop         # Stop; keep data and settings
pwsh ./deploy-local.ps1 edit-config  # Change settings
```

Run `start` again after changing settings. To keep a separate installation, add `-Project <name>` to each command.

## Documentation

| Guide | Covers |
| --- | --- |
| [Setup](docs/deployment-setup.md) | Entra registration, API permissions, multiple tenants, and dev tunnels |
| [Microsoft roles](docs/user-roles-and-permissions.md) | Roles needed for each action |
| [Usage reports](docs/official-usage-import.md) | CSV exports and imports |
| [Copilot licenses and usage](docs/copilot-license-usage.md) | License detection and activity data |
| [Operations](docs/operations.md) | Troubleshooting, tests, backups, and recovery |
| [Security](docs/security-model.md) | Authentication, authorization, and data isolation |
| [Azure deployment](docs/azure-production-deployment.md) | Azure requirements and release steps |
