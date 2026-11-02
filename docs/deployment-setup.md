# Deployment setup

Configure Microsoft Entra ID and start Agent Control locally.
For Azure hosting, complete the Entra steps here, then use
[Azure production deployment](azure-production-deployment.md).

## Prerequisites

- Git and a checkout of this repository.
- PowerShell 7.
- Docker Desktop with Linux containers, or Docker Engine with Compose v2.
- An Entra administrator who can register applications, assign app roles and
  grant tenant admin consent.

Node.js and PostgreSQL run in containers; host installations are not required.
Run the commands below from the repository root.

## Configure the Entra application

Create one registration per tenant. All registrations in an installation use
the same browser callback URL.

### 1. Register Agent Control

1. Open **Microsoft Entra admin center > Identity > Applications >
   App registrations > New registration**.
2. Name the application `Agent Control`.
3. Select **Accounts in this organizational directory only**.
4. Add a **Web** redirect URI:

   ```text
   http://localhost:3001/api/auth/callback
   ```

5. Register the application.
6. Copy the **Directory (tenant) ID** and **Application (client) ID** from
   **Overview**.

Use the selected local port if it is not `3001`. For a public installation,
register `https://<public-host>/api/auth/callback` instead.

### 2. Create a client secret

1. Open **Certificates & secrets > New client secret**.
2. Choose an expiry that follows your organization's credential policy.
3. Copy the secret **Value** immediately, not the secret ID.
4. Keep it in protected storage until entering it into the setup wizard.

Do not put the value in commands, source control, logs or chat.

### 3. Add the app roles

Import only the `appRoles` array from
[`infra/entra-app-manifest.json`](../infra/entra-app-manifest.json), preserving
the registration's other settings. Alternatively, create the same enabled
roles manually with **Users/Groups** as the allowed member types.

Use the [role and permission reference](user-roles-and-permissions.md) to
choose Viewer, Usage Report Uploader or Admin access. App roles control Agent
Control access; they do not grant Microsoft API permissions.

### 4. Require assignment

1. Open **Enterprise applications > your application > Properties**.
2. Set **Assignment required?** to **Yes**.
3. Under **Users and groups**, assign one appropriate Agent Control role to
   each approved user or group.
4. Have users sign out and back in after assignment changes.

### 5. Add API permissions

Open **App registrations > your application > API permissions**.
Add the application, delegated and sign-in permissions in the
[app registration permissions checklist](user-roles-and-permissions.md#app-registration-permissions),
then select **Grant admin consent**.

Use that reference for Microsoft role assignments, licensing and feature-specific
requirements. Sign-in does not request these grants.

- Graph synchronization uses the configured application's credentials and consent.
- Power Platform synchronization uses the signed-in user's delegated access.
- Users without source-read access can still read saved tenant data.
- Investigation-only permissions are not prerequisites for ordinary synchronization.

## Start locally

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control
```

On first start, enter the tenant ID, client ID, client secret value, accepted
sign-in domains and local port. Configuration is saved under
`.local/agent-control/`; no `.env` file is needed.

Open `http://localhost:3001`, or the port selected in the wizard, and sign in
with an assigned work or school account.

### Check permissions and collect data

- Keep the browser visible and online. Read-only synchronization starts
  automatically after sign-in; no administrator session or application-enable
  step is required.
- Open **Sync** for source progress and explicit refreshes.
- Use **Permissions > Check status** after an actual source failure, not before
  synchronization.
- Use **Continue to workspace** to dismiss the informational first-sync modal
  while collection continues.
- Import official agent-usage CSVs separately using the
  [report import guide](official-usage-import.md).

A Power Platform permission failure does not prevent application-based Graph
sources from synchronizing. Previously saved complete sources remain readable
while a refresh runs or fails.

## Change local settings

```powershell
pwsh ./deploy-local.ps1 edit-config -Project agent-control
pwsh ./deploy-local.ps1 start -Project agent-control
```

The wizard edits tenant profiles, credentials, domains, port and optional public
HTTPS origin. It hides secret input and keeps saved values when Enter is pressed.
If the public origin or port changes, update every registration's Web callback
to `<configured-origin>/api/auth/callback`.

Use a separate project for an independent installation:

```powershell
pwsh ./deploy-local.ps1 start -Project contoso
```

Project state is stored under `.local/<project>/`. Use that exact project name
for subsequent configuration, start, stop and recovery commands.

## Configure multiple tenants

```powershell
pwsh ./deploy-local.ps1 edit-config -Project agent-control
pwsh ./deploy-local.ps1 start -Project agent-control
```

Choose **Add another tenant** in the editor. Each tenant needs its own
registration, credential, app-role assignments and admin consent.

Enter every accepted sign-in domain explicitly. Routing uses exact domains:
domains cannot overlap between profiles, and subdomains are not included
automatically. All tenant registrations use this installation's callback URL.

## Recover from failed database initialization

Startup accepts an empty database or this build's current schema. It does not
migrate incompatible schemas or delete data automatically.

1. Read the reported Docker, database, credential or permission failure.
2. Correct that failure without deleting project settings, secrets or volumes.
3. Retry ordinary start:

   ```powershell
   pwsh ./deploy-local.ps1 start -Project agent-control
   ```

If a previous explicit reset completed, this retry finishes initialization
without requesting another reset. If the reset outcome is unknown, follow
[installation maintenance](operations.md#existing-installation-maintenance)
before retrying.

An incompatible schema requires the
[explicit data-reset procedure](operations.md#reset-application-data), with
exact-target and data-loss confirmation. A permission change or Docker launch
failure is not a reason to reset data. Successful initialization or reset returns
to normal automatic synchronization after sign-in.

On Windows, use PowerShell 7 and Linux containers. An elevated shell is not
required. If Docker cannot launch, check `docker version` in the same shell;
do not reset PostgreSQL to resolve a Docker CLI error.

## Run software checks

```powershell
pwsh ./deploy-local.ps1 check -Project agent-control
```

To check and deploy the same source snapshot:

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control -ForceChecks
```

`check` builds a fixed source snapshot and runs isolated software/database
fixtures. It does not deploy or change the application's configuration or data.
Normal `start` builds the application and verifies configuration, schema and
readiness without running the full regression suite.

## Optional MCP service

MCP is not required for browser sign-in, synchronization or administration.
Use [MCP client setup](mcp-clients.md) for client connections and
[MCP integration](mcp-integration.md) for service installation, configuration
and authorization.

### Optional delegated API binding

The integration guide defines the optional tenant-profile `integration` object
and separate Entra registrations. Omit it for browser-only operation.

### Optional local MCP container

For guided setup of an existing local project:

```powershell
pwsh ./deploy-local.ps1 edit-config -Project agent-control -ConfigureMcp
pwsh ./deploy-local.ps1 start -Project agent-control
```

Complete the registration, HTTPS endpoint and callback requirements in
[MCP integration](mcp-integration.md) first. Normal start includes an already
configured MCP service; `-ConfigureMcp` is a setup action, not a runtime switch.

## Deploy to Azure

Follow [Azure production deployment](azure-production-deployment.md) for the
supported resource profile, release ZIP build, prepared Key Vault and deployment
commands. Use [Operations](operations.md) for ongoing local maintenance.
