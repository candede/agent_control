# Agent Control

Discover and manage Microsoft 365 and Copilot Studio agents from one dashboard.

- Browse agents, owners, environments, and access assignments.
- Track Copilot licenses, adoption, and agent usage.
- Manage package availability and Copilot Studio quarantine.
- Investigate activity with Microsoft Purview and Defender.

## Quick start

### 1. Install the prerequisites

Install:

- Git
- PowerShell 7
- Docker Desktop, or Docker Engine with Compose v2

Clone the repository:

```bash
git clone https://github.com/candede/agent_control.git
cd agent_control
```

Node.js and PostgreSQL run in containers. You do not need to install them on the
host.

### 2. Configure Microsoft Entra ID

Create or select an Entra app registration, then follow the
[setup guide](docs/deployment-setup.md) to configure:

- the callback URL;
- the Viewer and Admin app roles;
- user or group assignments;
- Microsoft API permissions and admin consent.

For the default local port, use this Web redirect URI:

```text
http://localhost:3001/api/auth/callback
```

Have the tenant ID, client ID, client secret value, and accepted sign-in domains
ready.

### 3. Start Agent Control

```powershell
pwsh ./deploy-local.ps1 start
```

The first start opens a setup wizard and saves configuration under
`.local/agent-control/`. It then builds and starts the app with PostgreSQL.

Open [http://localhost:3001](http://localhost:3001), or the port selected in the
wizard, and sign in with an assigned work or school account.

### 4. Collect data

Open **Permissions** to check access, then open **Sync** to collect agent,
environment, user, license, and activity data.

To add Microsoft 365 Copilot agent usage, export the **Agents**,
**Users & agents**, and **Users** CSV reports for the same period and import them
from **Sync > Add CSV reports**. See the
[usage import guide](docs/official-usage-import.md).

## Common commands

```powershell
pwsh ./deploy-local.ps1 start        # Start or update
pwsh ./deploy-local.ps1 stop         # Stop and keep data
pwsh ./deploy-local.ps1 edit-config  # Change saved settings
pwsh ./deploy-local.ps1 check        # Run software checks
```

Add `-Project <name>` to keep separate installations.

## Documentation

| Guide | Covers |
| --- | --- |
| [Setup](docs/deployment-setup.md) | Entra ID, permissions, local setup, and multiple tenants |
| [Microsoft roles](docs/user-roles-and-permissions.md) | Roles required for each feature |
| [Usage reports](docs/official-usage-import.md) | Exporting and importing Microsoft 365 reports |
| [Operations](docs/operations.md) | Updates, troubleshooting, backups, and recovery |
| [Security](docs/security-model.md) | Authentication, authorization, and data isolation |
| [Azure deployment](docs/azure-production-deployment.md) | Production requirements and deployment |
