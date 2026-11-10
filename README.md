# Agent Control

Track Microsoft 365 Copilot adoption and manage Microsoft 365 and Copilot Studio agents.

- **Agents:** inventory, owners, environments, access, package availability and Studio quarantine.
- **Users:** Copilot licenses, agent activity and Copilot usage in Office apps.
- **Dashboard:** adoption trends, department participation and potential champions.
- **CSV imports:** upload official agent-usage reports using Admin or report-uploader access.

## Quick start

### 1. Install the prerequisites

Install **Git** and **Docker Desktop** or **Docker Engine with Compose v2**.
Windows/macOS use **PowerShell 7**. On Ubuntu/native Linux, `deploy-local.sh`
automatically runs the same deployment core in a Docker helper when PowerShell
is not installed.

Clone the repository:

```bash
git clone https://github.com/candede/agent_control.git
cd agent_control
```

Node.js and PostgreSQL run in containers; no host installation is needed.

### 2. Configure Microsoft Entra ID

Use the [setup guide](docs/deployment-setup.md) to create the app registration,
callback URL, client secret, app roles, user assignments and API permissions.
Default local URL: `http://localhost:3001`.

### 3. Start Agent Control

```powershell
pwsh ./deploy-local.ps1 start
```

On Ubuntu/native Linux:

```bash
./deploy-local.sh start
```

The first start opens a setup wizard, saves configuration under
`.local/agent-control/`, and starts the app with PostgreSQL.

Open [http://localhost:3001](http://localhost:3001), or the port selected in the
wizard, and sign in with an assigned work or school account.
Standalone remains the default. For an independently managed shared HTTPS proxy,
see [optional shared ingress](docs/deployment-setup.md#optional-independent-shared-ingress).

### 4. Collect data

Read-only sync starts automatically after sign-in while the app is visible and
online. **Sync** shows progress; **Permissions** diagnoses access failures.
All app roles share saved tenant data, even without permission to collect it.

| Source | Data collected |
| --- | --- |
| Microsoft Graph (application permissions) | Published agents/packages, users, Copilot licenses and Copilot usage in Office apps |
| Power Platform (signed-in user's delegated access) | Copilot Studio agents and environments |
| Imported Microsoft 365 CSVs | Copilot agent usage |

For agent usage, export **Agents**, **Users & agents** and **Users** for the same
period, then import them through **Sync > Add CSV reports**.
[Export and import instructions](docs/official-usage-import.md).

## Permissions

- **App roles:** what a user can do in Agent Control.
- **Application permissions:** what Agent Control can read using its own identity.
- **Delegated permissions:** what Agent Control can do using the signed-in user's Microsoft access.

### App-defined roles

| App role | Allowed tasks |
| --- | --- |
| `AgentControl.Viewer` | Read shared tenant data; run read-only sync |
| `AgentControl.UsageReportUploader` | Viewer access; upload, validate and publish CSV reports; discard own drafts |
| `AgentControl.Admin` | Viewer/Uploader access; manage agents and settings; correct/delete published reports; read/export audit logs |

Assign one role per user or group through **Enterprise applications > Agent
Control > Users and groups**. Uploader includes Viewer; Admin includes both.
App roles do not grant Microsoft API access.

## App registration permissions

Configure these permissions in the app registration and grant tenant admin
consent. Sign-in does not request these grants. Microsoft roles and licenses are
separate requirements.

### Microsoft Graph / Application

Used for automatic Graph sync. The signed-in user needs no Microsoft directory
or reporting role.

| Permission | Used by Agent Control to |
| --- | --- |
| `CopilotPackages.Read.All` | Retrieve published agents, package metadata and sharing details. Requires applicable Microsoft Agent 365 licensing. |
| `User.Read.All` | Retrieve users and Copilot license assignments; identify agent owners; find and validate users for access changes. |
| `LicenseAssignment.Read.All` | Retrieve product and service-plan catalog entries to identify Copilot licenses. |
| `Reports.Read.All` | Retrieve each user's Copilot usage in Office apps (last 28 days) for the Office adoption dashboard and **Users > Adoption > Office apps**. |

### Microsoft Graph / Delegated

| Permission | Used by Agent Control to |
| --- | --- |
| `CopilotPackages.ReadWrite.All` | Block/unblock packages, change availability and installation assignments, and verify changes in **Agents > Manage**. |
| `Group.Read.All` | Find groups for package availability and installation assignments. |

Package changes require a **Microsoft Agent 365 license** and a **delegated work
or school account**. Application permissions cannot authorize these writes.
**Recommended role:** **AI Administrator**; **Global Administrator** is broader.
The package API does not specify a minimum role.
[Role and API requirements](docs/user-roles-and-permissions.md#package-management-administrator-roles).

### Power Platform / Delegated

| Permission | Used by Agent Control to | Microsoft role |
| --- | --- | --- |
| `ResourceQuery.Resources.Read` | Retrieve Copilot Studio agents and environments. | Recommend **AI Reader** for read-only sync. |
| `CopilotStudio.AdminActions.Invoke` | Read quarantine status; quarantine or restore Studio agents. | **AI Administrator**, **Power Platform Administrator** or **Global Administrator**, including for status reads. |

Inventory sync has no application-permission equivalent. For role assignments
and other supported roles, see [Power Platform access](docs/user-roles-and-permissions.md#power-platform-sync-roles).

### Sign-in / OpenID Connect

Sign-in and token renewal only; these scopes do not authorize inventory reads or
management changes.
`User.Read` is not used.

| Scope | Purpose |
| --- | --- |
| `openid` | Sign in using an ID token. |
| `profile` | Display the signed-in account's name and username. |
| `offline_access` | Renew delegated tokens when Microsoft policy allows. |

## Usage report access

- **Export from Microsoft 365:** **Reports Reader** or **AI Administrator**.
  **Usage Summary Reports Reader** does not include user details.
- **Import into Agent Control:** `AgentControl.UsageReportUploader` or
  `AgentControl.Admin`; no Microsoft token needed.

See the [permissions reference](docs/user-roles-and-permissions.md) and
[registration setup](docs/deployment-setup.md#5-add-api-permissions).

## Common commands

```powershell
pwsh ./deploy-local.ps1 start        # Start or update
pwsh ./deploy-local.ps1 stop         # Stop and keep data
pwsh ./deploy-local.ps1 edit-config  # Change saved settings
pwsh ./deploy-local.ps1 check        # Run software checks
```

Add `-Project <name>` to keep separate installations.

## Documentation

Optional: [set up the MCP server](docs/mcp-integration.md) to
connect AI clients to Agent Control. The web app does not require it.

| Guide | Covers |
| --- | --- |
| [Setup](docs/deployment-setup.md) | Entra ID, permissions, local setup, and multiple tenants |
| [Microsoft roles](docs/user-roles-and-permissions.md) | Roles required for each feature |
| [Usage reports](docs/official-usage-import.md) | Exporting and importing Microsoft 365 reports |
| [Office adoption](docs/copilot-license-usage.md) | Copilot licenses, Office app activity and adoption metrics |
| [Operations](docs/operations.md) | Updates, troubleshooting, backups, and recovery |
| [Saved data](docs/data-architecture.md) | Database schema, storage and retention |
| [Provider contracts](docs/provider-contracts.md) | Supported Microsoft APIs, permissions and limits |
| [Security](docs/security-model.md) | Authentication, authorization, and data isolation |
| [MCP clients](docs/mcp-clients.md) | Client setup, authentication and tools |
| [Azure deployment](docs/azure-production-deployment.md) | Production requirements and deployment |
