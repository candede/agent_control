# Agent Control Entra app registrations

The web application needs one **Agent Control** registration. The optional MCP
service needs a second **Agent Control MCP** registration; it uses the same
canonical API, app roles and provider authorization, not a second permission
system. MCP is not required for browser sign-in or automatic synchronization.

Use the [deployment guide](../docs/deployment-setup.md) for runtime configuration.
The [Permissions reference](../docs/user-roles-and-permissions.md) describes the
same app roles and Microsoft permissions as the current page.

## Registration boundaries

| Registration | Owns |
| --- | --- |
| Agent Control | Browser sign-in, canonical API, app-defined roles, Microsoft provider permissions and application credentials. |
| Agent Control MCP, optional | MCP OAuth, its own audience/callback/credentials, and delegated access to the canonical API. No copied Graph or Power Platform grants. |

Use distinct client IDs and credentials in the same configured tenant. Do not
mix production credentials with development callbacks.

| Setting | Synthetic example |
| --- | --- |
| Tenant ID | `11111111-1111-1111-1111-111111111111` |
| API client ID | `22222222-2222-2222-2222-222222222222` |
| MCP client ID | `33333333-3333-3333-3333-333333333333` |
| Browser callback | `https://portal.example.com/api/auth/callback` |
| Optional API scope | `api://22222222-2222-2222-2222-222222222222/AgentControl.Access` |
| MCP public resource | `https://mcp.example.com/mcp` |
| MCP Entra callback | `https://mcp.example.com/auth/callback` |
| MCP scope | `api://33333333-3333-3333-3333-333333333333/Mcp.Access` |

Client IDs are not application/service-principal object IDs. A scope-definition
GUID is not its readable scope value. A secret ID is not a credential's **Value**.
Never put credentials, tokens or authorization codes in this worksheet.

## Configure the web registration

1. In **Microsoft Entra admin center > Identity > Applications > App
   registrations**, create **Agent Control** for **Accounts in this
   organizational directory only**.
2. Register the actual browser callback as **Web**:
   `https://<web-origin>/api/auth/callback`, or
   `http://localhost:3001/api/auth/callback` for local development.
3. Keep implicit grants and public-client flows disabled for this confidential
   backend.
4. Record the tenant and application/client IDs.
5. Create a client secret under **Certificates & secrets**. Store its **Value**
   in the deployment's protected configuration, not source code or client
   settings. Record expiry and rotation ownership without recording the value.
6. Configure app roles and API permissions as described below.

## App-defined roles

Import only the `appRoles` array from the current
[manifest](entra-app-manifest.json), or create these exact values manually.
Roles must be enabled and allow **Users/Groups** (`"User"` in the manifest),
not workload/application assignments.

| App role | Allowed tasks |
| --- | --- |
| `AgentControl.Viewer` | Read shared agents, users, reports and saved sync results; run read-only sync. |
| `AgentControl.UsageReportUploader` | Viewer access; upload, validate and publish new CSV sets; discard own unaccepted drafts. |
| `AgentControl.Admin` | Viewer/Uploader access; provider changes, published-report corrections/selection/deletion, configuration and local Audit read/export. |

Open **Enterprise applications > Agent Control > Properties** and set
**Assignment required?** to **Yes**. Under **Users and groups**, assign each
approved user/group one role. Uploader includes Viewer; Admin includes both.
Sign out/in after assignment changes. Group assignment requires the applicable
Entra licensing; nested group assignments do not cascade.

Only Admin can see the Audit tab/page or read/export local administrative audit
logs, including by direct API request. Audit recording is unchanged.
App roles do not grant Microsoft permissions, roles or licenses.

## App registration permissions

Under **App registrations > Agent Control > API permissions**, configure the
current Permissions page's **11 entries in four groups**, then grant tenant admin
consent. Sign-in does not request these additional API grants. This section
describes Microsoft access; local app roles are covered above.

### Microsoft Graph / Application

Application credentials and tenant admin consent support automatic reads
without signed-in Microsoft directory/reporting roles.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `CopilotPackages.Read.All` | Published Copilot agent/package inventory, metadata and sharing details. Requires applicable Microsoft Agent 365 licensing, application credentials and tenant admin consent. |
| `User.Read.All` | Directory users and Copilot license assignments; exact creator/owner resolution; management user search and user-ID validation. |
| `LicenseAssignment.Read.All` | Tenant product SKUs and service-plan catalog. |
| `Reports.Read.All` | 28-day per-user Copilot Office-app activity; does not replace the three imported agent-usage CSV reports. |

### Microsoft Graph / Delegated

Signed-in user identity supports management group lookups and package changes.
User lookups use application access.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `CopilotPackages.ReadWrite.All` | Package block/unblock, availability/installation assignments and control readback. Requires delegated tenant admin consent and a Microsoft Agent 365 license. Recommended signed-in administrator role: **AI Administrator**; **Global Administrator** is a broader alternative. Package writes support delegated work or school accounts only. |
| `Group.Read.All` | Management group search/resolution using the signed-in user's delegated directory visibility. |

Microsoft defines both application and delegated forms of the package permission,
but the application form does not authorize these writes. Select **Microsoft
Graph > Delegated permissions** for package controls, then grant tenant admin
consent. The role recommendation follows Microsoft's agent-management guidance
for the Microsoft 365 admin center. The package API does not publish an explicit
role minimum; this is not a confirmed exclusive API role requirement. See the
[recommended administrator role and API support](../docs/user-roles-and-permissions.md#package-management-administrator-roles).

### Power Platform / Delegated

Power Platform is separate from Graph. Inventory and administrative actions
depend on the signed-in user's Microsoft privileges.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `ResourceQuery.Resources.Read` | Studio agents and environment inventory. Recommend **AI Reader**, the least-privileged supported Entra inventory role for this sync; **no application permission equivalent**. Saved tenant data remains readable without sync access. |
| `CopilotStudio.AdminActions.Invoke` | Studio quarantine status and quarantine/restore. Both status and changes require **AI Administrator**, **Power Platform Administrator** or **Global Administrator**. |

An Entra **Privileged Role Administrator** assigns AI Reader through **Identity >
Roles & admins > AI Reader > Add assignments**, selects the viewer and selects
**Add**. The viewer signs out/in, first activating the role if PIM-eligible.
The delegated API permission also needs consent; it is not a user role, and
inventory access grants neither quarantine status nor changes.

Global Reader, AI Administrator, Power Platform Administrator, Dynamics 365
Administrator and Global Administrator also work if already assigned. AI roles
cover AI-scoped resources; broader roles are unnecessary for this sync.
These are inventory-feature roles; the REST API publishes no separate minimum.
See the [full assignment instructions](../docs/user-roles-and-permissions.md#assign-ai-reader-to-a-viewer).

### Sign-in / OpenID Connect

These are sign-in scopes, not Graph data permissions. They do not authorize
inventory reads or administrative changes. `User.Read` is not used.

| Scope | Purpose |
| --- | --- |
| `openid` | Authenticate the account using an ID token; no provider-data access. |
| `profile` | Display the account's name and username. |
| `offline_access` | Renew delegated tokens when Microsoft policy allows; no additional API permissions. |

## Synchronization and reports

Read-only sync starts automatically after permitted sign-in while the browser is
visible and online. No separate administrator session, prior Permissions visit,
qualification or application-owned approval/enable step is required.
Missing Power Platform access does not prevent Graph collection or saved-data
reads. Application-token failures require fixing credentials/consent, not
granting the signed-in user a broader Microsoft role.

Local CSV import uses no Microsoft token. Downloading the original user-level
reports from Microsoft 365 requires **Reports Reader** or **AI Administrator**;
**Usage Summary Reports Reader** does not include user details. The three
**Agents**, **Users & agents**, and **Users** exports remain separate from Graph
Office-app activity.

Purview, Defender and investigation-only identity setup are hidden from the
current UI and are not part of this setup. Their retained backend contracts are
documented separately in [provider contracts](../docs/provider-contracts.md#retained-backend-investigations).

## Optional MCP registration and consent

### Expose the canonical API scope

On the existing Agent Control registration:

1. Under **Expose an API**, set the Application ID URI to `api://<API_CLIENT_ID>`.
2. Add the enabled, admin-consented delegated scope **AgentControl.Access**.
3. Set **Manifest > api.requestedAccessTokenVersion** to **2**.
4. Preserve the existing app-role definitions, assignments and provider grants.

The API validates an access token's audience as the **API client GUID**, not the
scope URI or MCP audience. It also checks tenant, issuer, signature, expiry,
delegated scope, current user roles and the configured MCP calling-client `azp`.
Preauthorization is consent configuration, not a replacement for caller checks.

### Create the separate MCP registration

Create **Agent Control MCP** in the same tenant, with single-tenant account type
and a **Web** callback of `https://<mcp-origin>/auth/callback`.
Do not append `/mcp` to that callback. Keep implicit grants and public-client
flows disabled.

1. Under **Expose an API**, set `api://<MCP_CLIENT_ID>` and add the enabled,
   admin-consented delegated scope **Mcp.Access**.
2. Set **api.requestedAccessTokenVersion** to **2**.
3. Under **API permissions > My APIs**, add Agent Control's delegated
   **AgentControl.Access**.
4. Include the MCP registration's own delegated **Mcp.Access** in its consent
   set. If the self-resource is absent from the portal picker, declare it using
   the manifest/Graph with the actual resource client ID and scope-definition
   GUID. Declaring a permission does not grant consent.
5. Grant administrator consent for both custom-resource permissions and required
   sign-in scopes. Consent to API access does not consent to MCP sign-in.
6. Create a **separate** MCP client secret. Never copy the API secret or provider
   credentials into MCP.

If assignment is required on the MCP enterprise application, also assign its
approved users/groups (Default Access if it defines no roles). That assignment
does not replace the three Agent Control roles on the API enterprise application.

The upstream MCP request uses `api://<MCP_CLIENT_ID>/Mcp.Access` plus
`openid profile offline_access`, not Graph scopes. MCP exchanges the resulting
MCP-audience Entra assertion for `api://<API_CLIENT_ID>/AgentControl.Access`.
The consumer receives MCP-issued credentials, not either server's confidential
credential or a Graph token.

### Bind deployment configuration

Inside the existing tenant profile, configure:

```json
{
  "integration": {
    "clientId": "33333333-3333-3333-3333-333333333333",
    "audience": "22222222-2222-2222-2222-222222222222",
    "scope": "AgentControl.Access"
  }
}
```

Replace these synthetic IDs with the actual MCP and API client IDs. Missing
integration configuration disables bearer admission without changing browser
operation. MCP signing/encryption keys are independent of Entra client secrets
and must persist across restarts. Use the
[MCP service/container setup](../docs/deployment-setup.md#optional-mcp-service)
for exact protected-file/environment settings and
[client recipes](../docs/mcp-clients.md) for discovery, PKCE, resource indicators,
refresh and exact allowed consumer callbacks.

| Callback | Configure in |
| --- | --- |
| `https://<web-origin>/api/auth/callback` | Agent Control registration, Web redirect. |
| `https://<mcp-origin>/auth/callback` | MCP registration, Web redirect. |
| Actual consumer OAuth callback | MCP downstream redirect allowlist, not the Entra registration. |

The API uses its own credential for provider token acquisition. Graph collection
uses the application grants above; delegated group lookups, Power Platform and
provider changes retain signed-in user authority. Graph and Power Platform
tokens are different resources. Never mix browser cookies with API bearer
credentials or treat a gateway-issued token as an Entra OBO assertion.

## Verify the affected journeys

- Sign in as Viewer on a new installation: automatic reads start without a
  separate Admin sign-in or manual enable step.
- Confirm saved tenant data remains readable when Microsoft source access fails.
- Confirm Viewer/Uploader cannot see Audit or call its read/export endpoints.
- Confirm Uploader can import new reports but cannot change published reports.
- For optional MCP, confirm the same user sees equivalent authorized saved data
  without first warming a browser session. Test refresh/reconnect and rejection
  of wrong audience, tenant, scope, calling client and absent app-role assignment.
- Provider changes require current Admin and Microsoft authority plus exact
  target confirmation. Never test destructive controls on ordinary user targets
  merely to prove sign-in.

Health checks and local fixtures are not proof of live Entra/provider access.
Use trusted local diagnostics and Entra sign-in logs; do not paste live tokens
or secrets into online decoders, chats or issue reports. Preserve Conditional
Access, MFA and guest policy rather than weakening them to bypass a failure.

## References

- [Expose a web API](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-expose-web-apis)
- [Configure client permissions](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-access-web-apis)
- [Define app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)
- [Assign users/groups](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)
- [Grant administrator consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)
- [On-behalf-of flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow)
- [FastMCP Azure integration](https://gofastmcp.com/integrations/azure)
