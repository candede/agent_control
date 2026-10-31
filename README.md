# Agent Control

Discover and manage Microsoft 365 and Copilot Studio agents from one dashboard.

- Browse agents, owners, environments, and access assignments.
- Track Copilot licenses, adoption, and agent usage.
- Manage package availability and Copilot Studio quarantine.
- Upload official usage reports with a dedicated non-admin report-uploader role.

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

Follow the [setup guide](docs/deployment-setup.md) to register Agent Control in
Microsoft Entra ID. The guide covers:

- creating the app registration;
- the callback URL;
- creating a client secret;
- the Viewer, UsageReportUploader and Admin app roles;
- user or group assignments;
- Microsoft API permissions and admin consent.

The normal local setup uses `http://localhost:3001`.

### 3. Start Agent Control

```powershell
pwsh ./deploy-local.ps1 start
```

The first start opens a setup wizard and saves configuration under
`.local/agent-control/`. It then builds and starts the app with PostgreSQL.

Open [http://localhost:3001](http://localhost:3001), or the port selected in the
wizard, and sign in with an assigned work or school account.

### 4. Collect data

Initial read-only synchronization starts automatically after any Viewer,
UsageReportUploader or Admin signs in while the app is visible and online.
Graph package, people, license and Office app activity collection uses application
permissions, not the signed-in user's Microsoft reader roles. Power Platform
collection remains delegated. **Sync** shows source progress and retained history.
Use **Permissions** to diagnose an actual authorization failure, not as a
prerequisite to collection.
You can dismiss first-sync progress and use saved data while collection continues.
Application-token failures require checking app configuration, not signing in as
a more privileged user.

To add Microsoft 365 Copilot agent usage, export the **Agents**,
**Users & agents**, and **Users** CSV reports for the same period and import them
from **Sync > Add CSV reports**. See the
[usage import guide](docs/official-usage-import.md).

Purview and Defender UI entry points and setup guidance are deferred. Their
backend implementations and saved data are unchanged.

**Dashboard** compares active users and active agents across retained reports,
with a selectable baseline and recent report-to-report direction. Company-filtered
department participation, people and engagement, and agents and champions panels
show where to focus support. Department percentages use saved directory members,
not a full workforce census. It does not estimate daily activity or treat import
dates as usage dates.

## Permissions

Application permissions authorize the app. **App roles** authorize users in
Agent Control. **Delegated permissions** use the logged-in user's Microsoft access.

The **Permissions** page has three always-visible sections: **Issues**,
**App-defined roles**, and **App registration permissions**, without a shortcut
bar. Issues show current diagnostics; the permission reference describes required
configuration, not proof of consent or successful provider access.

### App-defined roles

| App role | Allowed tasks |
| --- | --- |
| `AgentControl.Viewer` | Read shared tenant data and run read-only sync |
| `AgentControl.UsageReportUploader` | Viewer access; upload, validate and publish new CSV sets; discard own unaccepted drafts |
| `AgentControl.Admin` | Viewer/Uploader access; provider changes, published-report corrections/selection/deletion, configuration and local Audit read/export |

Assign roles through **Enterprise applications > Agent Control > Users and
groups**. Uploader includes Viewer; Admin includes both. Directly assigned cards
are purple and marked **Assigned to you**; inherited cards remain neutral and
marked **Included**. These roles never grant Microsoft provider access.

Only Admin can see the **Audit** tab/page or read/export local administrative
audit logs, including through direct URLs and APIs. Audit recording is unchanged.

## App registration permissions

These are the same **11 entries in four groups** shown on Permissions. Configure
the app registration and grant tenant admin consent; sign-in does not request
additional API consent. Microsoft roles and licensing are separate requirements.

### Microsoft Graph / Application

Application identity supports automatic Graph reads. No signed-in Microsoft
directory or reporting role is required.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `CopilotPackages.Read.All` | Published agent/package inventory, metadata and sharing details. Requires applicable Microsoft Agent 365 licensing, application credentials and tenant admin consent. |
| `User.Read.All` | Directory users and Copilot license assignments; exact creator/owner resolution; management user search and user-ID validation. |
| `LicenseAssignment.Read.All` | Product and service-plan catalog |
| `Reports.Read.All` | 28-day per-user Copilot Office-app activity; does not replace the three imported agent-usage CSV reports. |

### Microsoft Graph / Delegated

Signed-in user identity supports management group lookups and package changes.
User lookups use application access.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `CopilotPackages.ReadWrite.All` | Package blocking/unblocking, availability/installation assignments and control readback. Requires delegated tenant admin consent and a Microsoft Agent 365 license. Recommended signed-in administrator role: **AI Administrator**; **Global Administrator** is a broader alternative. Package writes support delegated work or school accounts only. |
| `Group.Read.All` | Management group search/resolution using the signed-in user's delegated directory visibility. |

Microsoft defines both application and delegated forms of the package permission,
but the application form does not authorize these writes. Configure
**Microsoft Graph > Delegated permissions**, not Application, for package
controls. The role recommendation follows Microsoft's agent-management guidance
for the Microsoft 365 admin center. The package API does not publish an explicit
role minimum; this is not a confirmed exclusive API role requirement. See the
[recommended administrator role and API support](docs/user-roles-and-permissions.md#package-management-administrator-roles).

### Power Platform / Delegated

Power Platform is separate from Graph. Inventory and administrative actions use
the signed-in user's Microsoft privileges.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `ResourceQuery.Resources.Read` | Copilot Studio agents and environment inventory. Recommend **AI Reader**, the least-privileged supported Entra inventory role for this sync. There is **no application permission equivalent**. Saved tenant data remains readable without sync access. |
| `CopilotStudio.AdminActions.Invoke` | Studio quarantine status and quarantine/restore. Both status and changes require **AI Administrator**, **Power Platform Administrator** or **Global Administrator**. |

**Assign AI Reader:** a **Privileged Role Administrator** opens **Microsoft Entra
admin center > Identity > Roles & admins > AI Reader > Add assignments**, selects
the viewer and selects **Add**. The viewer signs out/in, activating the role first
if PIM-eligible. Delegated API consent is still required; an API permission is not
a user role, and inventory access does not grant quarantine status or changes.

**Other roles, if already assigned:** Global Reader, AI Administrator, Power
Platform Administrator, Dynamics 365 Administrator and Global Administrator also
work. AI roles cover AI-scoped resources; do not assign broader roles solely for
this sync. These are inventory-feature roles; the REST API publishes no separate
role minimum. See the [assignment instructions and Microsoft references](docs/user-roles-and-permissions.md#power-platform-sync-roles).

### Sign-in / OpenID Connect

These sign-in scopes do not authorize inventory reads or administrative changes.
`User.Read` is not used.

| Scope | Purpose |
| --- | --- |
| `openid` | Authenticate the account using an ID token; no provider-data access. |
| `profile` | Display the signed-in account's name and username. |
| `offline_access` | Renew delegated tokens when Microsoft policy allows; no additional API permissions. |

## Usage report access

Local CSV import needs no Microsoft token. Downloading the original user-level
reports from Microsoft 365 requires **Reports Reader** or **AI Administrator**;
**Usage Summary Reports Reader** does not include user details. Import
authorization is covered by the app-defined roles above, not a Microsoft grant.

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

The optional [MCP service](docs/deployment-setup.md#optional-mcp-service)
is implemented as a separately runnable Python package with OAuth, encrypted
connection state and a canonical API adapter. Its [typed tools](docs/mcp-integration.md#implemented-typed-business-catalog-phase-06)
cover saved inventory/people/reports/investigations plus explicit application Graph
and delegated Power Platform collection, exact shared/package/Studio controls and
bounded job recovery.
Controls retain current API authority/receipts and client confirmation; uncertain
writes are never replayed automatically. Optional local container/lifecycle
support and [optional Azure source deployment tooling](docs/azure-production-deployment.md#optional-independent-mcp-app-service)
are implemented. Local software checks do not prove live Entra consent, provider
access, vendor-client compatibility or a working Azure deployment.
The web app needs none of it.

| Guide | Covers |
| --- | --- |
| [Setup](docs/deployment-setup.md) | Entra ID, permissions, local setup, and multiple tenants |
| [Microsoft roles](docs/user-roles-and-permissions.md) | Roles required for each feature |
| [Usage reports](docs/official-usage-import.md) | Exporting and importing Microsoft 365 reports |
| [Operations](docs/operations.md) | Updates, troubleshooting, backups, and recovery |
| [Saved data](docs/data-architecture.md) | Current schema, source publication, selections, and lifecycle |
| [Provider contracts](docs/provider-contracts.md) | Supported Microsoft contracts, permissions, limits, and evidence |
| [Security](docs/security-model.md) | Authentication, authorization, and data isolation |
| [MCP clients](docs/mcp-clients.md) | Versioned client onboarding, ordinary workflows, exact callbacks and synthetic proof limits |
| [Azure deployment](docs/azure-production-deployment.md) | Production requirements and deployment |
