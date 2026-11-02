# Enable the MCP server

Connect MCP clients to an existing Agent Control installation. Setup uses the
existing **Agent Control** Entra registration plus one new **Agent Control MCP**
registration.

## Before you start

- Have Agent Control running and permission to create Entra app registrations
  and grant administrator consent.
- Choose a public HTTPS address for MCP, such as `https://mcp.example.com/mcp`.
  Configure your HTTPS proxy/tunnel to forward to the MCP port, including OAuth
  and discovery paths on that hostname, not just `/mcp`.
- Keep the existing installation's tenant ID and Agent Control application
  (client) ID available.

| Address | Configure in |
| --- | --- |
| `https://mcp.example.com/mcp` | MCP setup wizard and client |
| `https://mcp.example.com/auth/callback` | New MCP Entra registration, **Web** redirect URI |
| Client's OAuth callback | MCP setup wizard's allowed client callbacks; not Entra |

Replace the example hostname with yours.

## 1. Update the existing Agent Control registration

In [Microsoft Entra admin center](https://entra.microsoft.com/), open
**Identity > Applications > App registrations > Agent Control**.

1. Open **Expose an API** and set **Application ID URI** to `api://<API_CLIENT_ID>`.
2. Select **Add a scope**, or keep the existing enabled scope:
   - **Scope name:** `AgentControl.Access`
   - **Who can consent:** Admins only
   - Fill the required consent display name/description; leave **State: Enabled**.
3. In **Manifest**, set `api.requestedAccessTokenVersion` to `2`.
4. Keep existing provider permissions and app roles. Assign MCP users a
   [Viewer, Uploader or Admin role](user-roles-and-permissions.md#app-defined-roles)
   on the **Agent Control** enterprise application.

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

On **Agent Control MCP > API permissions**:

1. **Add a permission > My APIs > Agent Control > Delegated permissions**:
   select `AgentControl.Access`.
2. Add the MCP registration's own delegated `Mcp.Access` permission.
3. Under **Microsoft Graph > Delegated permissions**, add the sign-in scopes
   `openid`, `profile` and `offline_access`.
4. Select **Grant admin consent** for the tenant.

Do not copy Graph data or Power Platform permissions from the API registration.
If the MCP enterprise application requires assignment, assign its users/groups
there too; this does not replace their Agent Control app roles.

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

For a named installation, append `-Project <your-existing-project-name>`.
Enter:

| Wizard prompt | Value |
| --- | --- |
| API tenant profile | Existing Agent Control tenant |
| MCP Entra application ID | `<MCP_CLIENT_ID>` from step 2 |
| Public HTTPS resource URL | `https://mcp.example.com/mcp` |
| Allowed client callback URLs | Exact URLs for your client, comma-separated; see below |
| MCP loopback port | Normally `8001`; use the port selected by the wizard |
| MCP Entra client secret | Secret **Value** from step 2; hidden input |

For VS Code, paste these callbacks as one line:

```text
https://insiders.vscode.dev/redirect,https://vscode.dev/redirect,http://127.0.0.1/,http://127.0.0.1:33418/
```

For other clients, use their [callback instructions](mcp-clients.md#choose-a-client).
Point your HTTPS proxy/tunnel at the selected loopback port.

The wizard saves the API binding, generates protected signing/encryption keys
on first setup, and starts the MCP container. It does not create Entra apps or
HTTPS ingress. Keep its saved keys and OAuth volume; do not regenerate them on restart.

After setup, normal startup includes MCP:

```powershell
pwsh ./deploy-local.ps1 start
```

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

Start the server connection, complete Entra sign-in and run `list_capabilities`.
Then request a saved agents/users list. Never put the server secret into client
settings. Health/readiness alone does not verify OAuth or data access.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Redirect mismatch | Entra uses `/auth/callback`; client callbacks belong in the wizard allowlist |
| Consent or API access denied | Both custom scopes have admin consent; user has an Agent Control app role |
| Discovery/login page unreachable | HTTPS ingress forwards MCP discovery/OAuth paths as well as `/mcp` |
| Missing signing/encryption keys | Restore the original protected keys/state; do not start with replacement keys |

## Other deployment options

- [Other MCP clients](mcp-clients.md)
- [Azure MCP deployment](azure-production-deployment.md#optional-independent-mcp-app-service)
- [Manual configuration, API/tool contracts and recovery](mcp-reference.md)
