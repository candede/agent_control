# Enable the MCP server

Connect MCP clients to an existing Agent Control installation. Setup uses the
existing **Agent Control** Entra registration plus one new **Agent Control MCP**
registration.

## Before you start

- Have Agent Control running and permission to create Entra app registrations
  and grant administrator consent.
- Choose a public HTTPS address for MCP, such as `https://mcp.example.com/mcp`.
  With Dev Tunnels, expose MCP's own port, not the web/API port. Sharing the
  web/API hostname requires a path-routing reverse proxy. Forward OAuth and
  discovery paths to MCP too, not just `/mcp`.
- Keep the existing installation's tenant ID and Agent Control application
  (client) ID available.

| Address | Purpose | Configure in |
| --- | --- | --- |
| `https://mcp.example.com/mcp` | Endpoint clients call to use MCP tools | MCP setup wizard and client |
| `https://mcp.example.com/auth/callback` | Returns the user from Entra sign-in to the MCP server | New MCP Entra registration, **Web** redirect URI |
| Client's OAuth callback | Returns an OAuth authorization code from the MCP server to the client to finish connecting | MCP setup wizard's allowed client callbacks; not Entra |

Replace the example hostname with yours.
Client callbacks are not MCP tool endpoints. Their exact allowlist prevents
authorization codes being redirected to unintended destinations; it lists
callback addresses, not individual users or client installations.

## 1. Update the existing Agent Control registration

In [Microsoft Entra admin center](https://entra.microsoft.com/), open
**Identity > Applications > App registrations > Agent Control**.

1. Open **Expose an API** and set **Application ID URI** to `api://<API_CLIENT_ID>`.
2. Select **Add a scope**, or keep the existing enabled scope:
   - **Scope name:** `AgentControl.Access`
   - **Who can consent:** Admins only
   - Fill the required consent display name/description; leave **State: Enabled**.
3. In **Manifest**, set `api.requestedAccessTokenVersion` to `2`.
4. Keep existing provider permissions and app roles. Assign staff MCP users a
   [Viewer, Uploader or Admin role](user-roles-and-permissions.md#app-defined-roles)
   on the **Agent Control** enterprise application. After hardened deployment,
   set **Assignment required?** to **No** for employee admission; verified active
   members without roles receive discovery only.

Use the existing registration's application/client GUID for `<API_CLIENT_ID>`,
not its object ID. Do not create a replacement API registration.

## 2. Create the MCP Entra registration

In the **same tenant**, open **App registrations > New registration**:

1. **Name:** `Agent Control MCP`
2. **Supported account types:** Accounts in this organizational directory only
3. **Redirect URI:** Web → `https://mcp.example.com/auth/callback`
4. Select **Register** and copy its **Application (client) ID** as `<MCP_CLIENT_ID>`.
5. Under **Certificates & secrets > New client secret**, create a secret and
   save its **Value** securely. The wizard needs the value, not the secret ID.
6. Under **Expose an API**, set `api://<MCP_CLIENT_ID>` and add enabled scope
   `Mcp.Access`, with **Admins only** consent and the required consent labels.
7. In **Manifest**, set `api.requestedAccessTokenVersion` to `2`.

Leave implicit grants and public-client flows disabled. Do not reuse the API
registration's client secret.

## 3. Add MCP permissions and grant consent

Ensure your setup account is listed under **Owners** on both app registrations
so they appear in **My APIs**.

MCP acts as both an Entra OAuth client and a protected resource: it requests a
token for itself, then exchanges it for an API token (On-Behalf-Of).

On **Agent Control MCP > API permissions**:

1. **Add a permission > My APIs > Agent Control > Delegated permissions**:
   select `AgentControl.Access` for calls to the Agent Control API.
2. Add the MCP registration's own delegated `Mcp.Access` permission for MCP
   sign-in; this does not grant API access or application roles.
3. Under **Microsoft Graph > Delegated permissions**, add the sign-in scopes
   `openid`, `profile` and `offline_access`.
4. Select **Grant admin consent** for the tenant.

Do not copy Graph data or Power Platform permissions from the API registration.
Set **Assignment required?** to **No** on the existing MCP enterprise application
after hardened deployment. Retain existing assignments and consent; this does not
replace explicit Agent Control staff roles or grant employees staff authority.

<details>
<summary>If the MCP app's own scope is missing from My APIs</summary>

Copy the `id` for `Mcp.Access` from the MCP registration's
`api.oauth2PermissionScopes` in **Manifest**. Merge this entry into its
`requiredResourceAccess`, preserving other entries, then grant admin consent:

```json
{
  "resourceAppId": "<MCP_CLIENT_ID>",
  "resourceAccess": [
    { "id": "<MCP_ACCESS_SCOPE_ID>", "type": "Scope" }
  ]
}
```

`<MCP_ACCESS_SCOPE_ID>` is the scope-definition GUID, not the name `Mcp.Access`.

</details>

## 4. Configure and start the server

From the repository root:

```powershell
pwsh ./deploy-local.ps1 start -ConfigureMcp
```

For a named installation, append `-Project <your-existing-project-name>` and
use that same project name on subsequent commands.

The wizard identifies the selected project, then lists only the existing
Agent Control tenant configurations saved in that project. A project can contain
multiple tenants; this question selects a tenant within the project, not another
project. Enter a listed configuration number, or press Enter to select the shown
default (including when there is only one configuration). Each entry shows its
display name or domains, Entra tenant ID and existing Agent Control application
(client) ID. The following MCP application ID prompt needs the **separate MCP
registration** from step 2, not the existing application ID just displayed.

Enter:

| Wizard prompt | Value |
| --- | --- |
| Choose a configuration number | Number of an existing Agent Control tenant configuration in this project; Enter selects the shown default |
| MCP Entra application ID | `<MCP_CLIENT_ID>` from step 2 |
| Public HTTPS resource URL | Full public endpoint, for example `https://mcp.example.com/mcp`, not just `https://mcp.example.com`; no trailing slash |
| Allowed client callback URLs | Exact URLs for your client, comma-separated; see below |
| MCP loopback port | Normally `8001`; use the port selected by the wizard |
| MCP Entra client secret | Secret **Value** from step 2; hidden input |

The public MCP URL is required on first setup; the example is not a default.
On later edits, the wizard shows the saved URL and Enter keeps it.
Public resource and callback URLs must be canonical, contain no wildcards, and
be at most 2,048 characters. Resource and callback paths cannot contain repeated `/` separators,
and explicit ports must be from 1 to 65535. Callback paths are case-sensitive;
paths differing only by case are separate allowlist entries.

For VS Code, paste these callbacks as one line:

```text
https://insiders.vscode.dev/redirect,https://vscode.dev/redirect,http://127.0.0.1/,http://127.0.0.1:33418/
```

For Copilot Studio, M365 declarative agents, Microsoft Copilot Cowork and
Copilot CLI, see the [client callback reference](mcp-clients.md#oauth-callback-reference).
It includes Microsoft's documented Teams plugin callback and identifies which
callbacks must be obtained from the client rather than guessed. When adding a
client later, rerun `start -ConfigureMcp` for the same project and provide the
combined existing and new callbacks, comma-separated. `*` is not accepted.
Changing client callbacks does not change the MCP server's Entra `/auth/callback`.

Point your HTTPS proxy/tunnel at the selected loopback port.
MCP calls the API internally at `http://app:3001`, not through the web/API tunnel.
Changing the saved MCP port replaces the existing owned container on the next
start; readiness is verified against the new port. Update your proxy/tunnel target
to match.

The wizard saves the API binding, generates protected signing/encryption keys
on first setup, and starts the MCP container. It does not create Entra apps or
HTTPS ingress. Keep its saved keys and OAuth volume; do not regenerate them on restart.

For an existing project, database preflight uses the base Compose configuration
without MCP; new MCP settings and credentials are saved after preflight and builds
succeed. Adding the first API integration binding can restart the web app and
require users to sign in again, so schedule that setup outside a live demo.

After setup, normal startup includes MCP:

```powershell
pwsh ./deploy-local.ps1 start
```

For an offline source-only MCP rebuild, set
`AGENT_CONTROL_MCP_DEPENDENCY_IMAGE` to an existing cached MCP dependency/test
image. The local build owner verifies its immutable identity before/after
building, byte-matching `pyproject.toml`/`uv.lock`, Python 3.14.6/uv 0.12.17
layout and installed locked dependencies. Test/fixture builds additionally
require the declared development packages. Mismatches fail without installing
packages. The build runs with no network and rebuilds only the application wheel,
replacing its previous installed files; it does not reinstall third-party
dependencies. Without this input, dependency installation uses only the approved
feed and is cached separately from application source. Runtime packaging removes
development-only packages offline, including when reusing a test-image baseline.

An independent MCP-only update uses `Start-LocalMcp` and its
`mcp-operation.json` / `mcp-deployment.json` receipts as current MCP authority.
`deployment.json` remains the historical last coordinated application release;
do not describe its embedded MCP candidate as current after an independent
update. Preserve that application/reset provenance, the existing OAuth volume
and keys. Do not restart the API or reset data merely to update release bookkeeping.

Startup automatically persists a separate metadata-only key and shares it
read-only with the web API; no additional wizard question or consent is required.
Viewer-capable users can then open **MCP settings** (`/mcp-settings`) to see exact
runtime instructions, that caller's projected tools/schemas, independent
read-only API privacy values, callbacks and the known
host port. A stopped service or metadata-key problem remains an explicit settings
error, not a sign-in or business-admission failure. “Reachable” means API-to-MCP
only: the page does not certify the public tunnel or a native client's OAuth.

## 5. Connect and test a client

In VS Code, run **MCP: Add Server > HTTP** and enter
`https://mcp.example.com/mcp`. Alternatively, add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "agentControl": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

Start the server connection and complete Entra sign-in as the actual user.
Read `my_discovery_profile` with `{"request":{"action":"read","input":{}}}`,
then search `agent_catalog` or read `my_workplace`. Roleless active members get
only these safe discovery tools; staff additionally get their authorized saved
reads and `preview_end_user`. Staff may optionally read saved `capabilities`;
it is never a prerequisite. Initialize/list automatically reaches the API-owned
due read bootstrap, while business discovery itself remains provider-free.
Never put the server secret into client
settings. Health/readiness alone does not verify OAuth or data access.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Redirect mismatch | Entra uses `/auth/callback`; client callbacks belong in the wizard allowlist |
| Consent or API access denied | Both custom scopes have admin consent; employee is an active tenant member or staff has its explicit Agent Control role |
| Discovery/login page unreachable | HTTPS ingress forwards MCP discovery/OAuth paths as well as `/mcp` |
| Missing signing/encryption keys | Restore the original protected keys/state; do not start with replacement keys |

## Other deployment options

- [Other MCP clients](mcp-clients.md)
- [Azure MCP deployment](azure-production-deployment.md#optional-independent-mcp-app-service)
- [Manual configuration, API/tool contracts and recovery](mcp-reference.md)
