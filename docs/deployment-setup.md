# Deployment setup

Configure Microsoft Entra ID and start Agent Control locally.
For Azure hosting, complete the Entra steps here, then use
[Azure production deployment](azure-production-deployment.md).

## Prerequisites

- Git and a checkout of this repository.
- PowerShell 7.
- Running Docker Desktop with Linux containers, or Docker Engine with Compose v2.
- An Entra administrator who can register applications, assign app roles and
  grant tenant admin consent.

Node.js and PostgreSQL run in containers; no host installation is needed.
Builds use `https://packagefeedproxy.microsoft.io/npm/`; keep `.npmrc` and Docker
`NPM_CONFIG_REGISTRY` aligned, with no public-registry fallback.
Run commands from the repository root in an interactive terminal.
On Windows, use Linux containers; elevation is not required.

## Configure the Entra application

Create one registration per tenant. All registrations in an installation use
the same browser callback URL.

### 1. Register Agent Control

1. Open [Microsoft Entra admin center](https://entra.microsoft.com/) >
   **Identity > Applications > App registrations > New registration**.
2. Name the application `Agent Control`.
3. Select **Accounts in this organizational directory only**.
4. Add a **Web** redirect URI:

   ```text
   http://localhost:3001/api/auth/callback
   ```

5. Register the application.
6. Copy the **Directory (tenant) ID** and **Application (client) ID** from
   **Overview**.

Replace `3001` with the selected local port. For HTTPS, register
`https://<public-host>/api/auth/callback`; proxy/tunnel installs must also
[set Public URL](#change-local-settings) before sign-in.

### 2. Create a client secret

Open **Certificates & secrets > New client secret** and choose an expiry under
your credential policy. Copy the **Value** immediately, not the secret ID.
Keep it in protected storage for the wizard, never in commands, source control,
logs or chat.

### 3. Add the app roles

Open **App registrations > Agent Control > Manifest** and merge only the
`appRoles` array from
[`infra/entra-app-manifest.json`](../infra/entra-app-manifest.json), preserving
other settings. Alternatively, use **App roles > Create app role** with the
same display names and values, **Users/Groups** as allowed member types, and
**Enable this app role** selected.

Choose Viewer, Usage Report Uploader or Admin using the
[role reference](user-roles-and-permissions.md#app-defined-roles).
App roles grant Agent Control access, not Microsoft API permissions.

### 4. Require assignment

1. Open **Enterprise applications > your application > Properties**.
2. Set **Assignment required?** to **Yes**.
3. Under **Users and groups**, assign one appropriate Agent Control role to
   each user or group. Admin includes Uploader and Viewer; assign only one role.
4. Have users sign out and back in after assignment changes.

### 5. Add API permissions

Open **App registrations > your application > API permissions > Add a permission**.
Use the [permissions checklist](user-roles-and-permissions.md#app-registration-permissions)
for the exact grants:

1. Choose **Microsoft Graph > Application permissions** for standard Graph
   reads; use **Delegated permissions** for sign-in and management grants.
2. For Power Platform, choose **APIs my organization uses** and search for
   application ID `8578e004-a5c6-46e7-913e-12f58912df43`.
   Add its **Delegated permissions** from the checklist.
3. Select **Grant admin consent for \<tenant\>** and confirm the grants show
   **Granted for \<tenant\>**. Sign-in does not request these grants.

Graph sync uses saved application credentials; Power Platform uses the signed-in
user's delegated access and [reader role](user-roles-and-permissions.md#power-platform-sync-roles).
Use the reference for management roles and licensing. Saved tenant reads need
no source-read access; investigation-only grants are not setup prerequisites.

## Start locally

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control
```

First start opens the wizard:

| Wizard prompt | Input |
| --- | --- |
| Entra tenant ID | Registration Overview's **Directory (tenant) ID** |
| Entra client ID | **Application (client) ID**, not object ID |
| Entra client secret value | Secret **Value** from step 2; input is hidden |
| Accepted username domains | Exact domains, e.g. `contoso.com,contoso.onmicrosoft.com`; no usernames, URLs or wildcards |
| Local port | Enter for `3001`, or an available `1024`–`65535` port matching the callback |

Under `.local/agent-control/`, the wizard saves `settings.json`, protected
`secrets/tenants.json` credentials and generated database/session keys in
`secrets/`. `compose.env` is generated; no `.env` is needed.
Application data lives in Docker volume `agent-control_data`.

### Check permissions and collect data

1. Open the printed URL (`http://localhost:3001` by default). Sign in with an
   assigned work or school username from a configured domain; complete any MFA
   or Conditional Access challenge.
2. Keep the browser visible and online. Read-only synchronization starts
   automatically; no administrator session, Permissions visit or enable step is
   required. **Continue to workspace** dismisses the modal without cancelling sync.
3. Open **Sync**. Check **Users**, **Graph packages** and **Power Platform** for
   **Complete** and saved counts; open **Agents** and **Users** to verify saved
   reads. Health/readiness alone does not verify sign-in or provider access.
4. For a failed source, use **Permissions > Check status** and correct the
   reported credential, consent, role or licensing issue. A Power Platform
   failure does not block application-based Graph sync. Previously complete
   sources stay readable during a refresh or failure.

Collection is browser-driven, not an unattended scheduler. Import agent-usage
CSVs separately using the [report import guide](official-usage-import.md).

## Change local settings

```powershell
pwsh ./deploy-local.ps1 edit-config -Project agent-control
pwsh ./deploy-local.ps1 start -Project agent-control
```

The editor prompts for tenant IDs, secret, domains and optional display name,
then **Add another tenant?**, **Local port** and **Public URL**. Enter keeps
saved values; secrets are hidden. Application changes can stop the app until
`start`; identity/domain changes require sign-in again.

- **Local-only:** keep **Public URL** unset; enter `local` to clear it.
- **HTTPS proxy/tunnel:** enter only the origin, e.g. `https://control.example.com`,
  without a path or trailing slash. Supply your own ingress to the loopback port
  with `X-Forwarded-Proto: https`; the app trusts one proxy hop.
- After changing origin/port, update every registration's Web callback to
  `<origin>/api/auth/callback` and begin sign-in at that origin.

### Restart or stop without resetting data

```powershell
pwsh ./deploy-local.ps1 stop -Project agent-control
pwsh ./deploy-local.ps1 start -Project agent-control
```

Ordinary start reuses saved configuration and data; an unchanged healthy app
needs no restart. Keep `.local/<project>/` and `<project>_data` together; restore
missing secrets rather than regenerating them for an existing volume.
Use a different `-Project` only for an independent installation, and use that
exact name for all its commands. Never add `-DbReset` to an ordinary restart.

## Configure multiple tenants

Run [edit-config, then start](#change-local-settings); answer `y` to **Add another
tenant?** Each tenant needs its own registration, credential, app-role assignments
and consent, with this installation's callback. Add a profile rather than replacing
a tenant ID with retained data. Domains cannot overlap; subdomains must be
entered explicitly.

## Recover from failed database initialization

Startup accepts only an empty database or this build's current schema; it never
migrates incompatible schemas or deletes data automatically.

- Fix the reported failure, retain settings/secrets/volumes and retry ordinary
  `start`. A completed reset is not repeated. For an unknown reset outcome,
  follow [installation maintenance](operations.md#existing-installation-maintenance).
- Incompatible schema: follow the [reset procedure](operations.md#reset-application-data).
  Confirm the exact target and data loss before using `-DbReset`; it does not
  prompt again. Never reset for a permission or Docker launch failure.
- After successful initialization/reset, sign in; synchronization starts automatically.

## Run software checks

```powershell
pwsh ./deploy-local.ps1 check -Project agent-control
```

`check` runs isolated fixtures without deploying or changing application data
or configuration. To check and deploy the same source snapshot, add `-ForceChecks`
to `start`. Normal start verifies configuration, schema and readiness, not the
full regression suite.

## Optional MCP service

MCP is not required for browser sign-in, synchronization or administration.
Follow [Enable the MCP server](mcp-integration.md) for Entra registration and
startup, then [MCP client setup](mcp-clients.md) for client-specific settings.

### Optional delegated API binding

The MCP wizard saves the tenant-profile `integration` binding described in the
[technical reference](mcp-reference.md#advanced-service-configuration).
Browser-only operation does not need it.

### Optional local MCP container

Follow [MCP integration](mcp-integration.md#4-configure-and-start-the-server)
with this project's name after preparing its registration, HTTPS endpoint and
callbacks. Normal start includes saved MCP configuration; `-ConfigureMcp` is
setup, not a runtime switch.

## Deploy to Azure

Use [Azure production deployment](azure-production-deployment.md) for resources,
Key Vault, release ZIP and commands; [Operations](operations.md) for local maintenance.
