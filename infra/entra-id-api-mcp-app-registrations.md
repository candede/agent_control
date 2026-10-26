# Two App Registrations, One User: Securing a Web API and an MCP Server with Microsoft Entra ID

Adding a Model Context Protocol (MCP) server to an existing web application should not create a second authorization system. The web application and the MCP tools should reach the same API, enforce the same user permissions, and perform downstream operations as the same signed-in person.

Microsoft Entra ID supports this architecture, but the setup spans several places: **App registrations**, **Enterprise applications**, exposed scopes, API permissions, consent, credentials, and user assignments. A configuration can look complete in one screen while still missing a dependency in another.

This walkthrough connects those settings into one end-to-end design.

> **Scope:** A single-tenant, delegated-user architecture using authorization code flow and on-behalf-of (OBO) exchanges. The web application uses a confidential server-side backend, not a browser-only SPA. The MCP server uses an OAuth proxy, such as FastMCP's Azure integration, between MCP consumers and Entra. Portal labels and documentation were reviewed in October 2026.

## 1. Start with the identity boundaries

We will register two applications:

| Registration | Responsibilities |
| --- | --- |
| **Example Web API** | Signs users into the web application, protects the business API, owns application roles, and calls downstream services |
| **Example MCP Gateway** | Authenticates MCP users through Entra, protects the MCP endpoint, and calls the business API on those users' behalf |

The browser path is straightforward:

```text
Browser -> Web backend -> Business API logic -> Downstream service
             |
             +-> Entra authorization code sign-in
```

The MCP path introduces two resource boundaries:

```text
MCP consumer
    |
    | MCP OAuth authorization
    v
MCP gateway <---- authorization code flow ----> Entra
    |
    | OBO: MCP-audience Entra access token
    |      exchanged for an API-audience access token
    v
Business API
    |
    | OBO: API-audience access token
    |      exchanged for a downstream-service access token
    v
Microsoft Graph or another downstream API
```

The API remains the business authorization authority. The MCP gateway is an adapter, not a second implementation of the application's permissions.

### Why two registrations?

The MCP gateway and API have different audiences, credentials, callbacks, and responsibilities. Separate registrations let you express those boundaries explicitly.

- A token issued for the MCP gateway is not automatically valid at the API.
- The API can identify the gateway as its authorized calling application.
- The API owns downstream permissions; the gateway does not need copies of all of them.
- You can rotate one application's credential without rotating the other.

A resource-only API would not need a browser redirect URI or a credential merely to validate incoming tokens. This example needs both because the API registration also represents the web backend and performs downstream token acquisition. A separate SPA or native client would normally introduce another client registration.

## 2. Prepare a configuration worksheet

Use a separate registration pair for each environment. Do not mix production credentials with development redirect URLs.

The following values are synthetic:

| Item | Example |
| --- | --- |
| Tenant ID | `11111111-1111-1111-1111-111111111111` |
| API application/client ID | `22222222-2222-2222-2222-222222222222` |
| MCP application/client ID | `33333333-3333-3333-3333-333333333333` |
| Web application origin | `https://portal.example.com` |
| Web backend callback | `https://portal.example.com/api/auth/callback` |
| API Application ID URI | `api://22222222-2222-2222-2222-222222222222` |
| API delegated scope | `api://22222222-2222-2222-2222-222222222222/Api.Access` |
| MCP public resource URL | `https://mcp.example.com/mcp` |
| MCP Entra callback | `https://mcp.example.com/auth/callback` |
| MCP Application ID URI | `api://33333333-3333-3333-3333-333333333333` |
| MCP delegated scope | `api://33333333-3333-3333-3333-333333333333/Mcp.Access` |
| API user roles | `Api.Viewer`, `Api.Admin` |

**Scope and role values are application contracts, not decorative names.** These examples use generic identifiers. When configuring an existing implementation, substitute the exact values its code requires. Changing only the Entra role value from one name to another will not update the application.

Also distinguish these identifiers:

- **Application (client) ID:** Used in OAuth requests, audience validation, and calling-application checks.
- **Directory (tenant) ID:** Identifies the tenant that issues and governs the tokens.
- **Object ID:** Identifies a particular application object or service principal for directory management. It is not an OAuth client ID.
- **Scope ID:** The GUID identifying a scope definition. Different from its readable value, such as `Api.Access`.
- **Secret ID:** Credential metadata. It is not the secret value used to authenticate.

You need permission to create or manage the registrations, and an administrator authorized to consent to the selected permissions. Being an application owner does not automatically authorize every tenant-wide consent operation. See Microsoft's [admin-consent guidance](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent).

## 3. Register the web application and API

Open the [Microsoft Entra admin center](https://entra.microsoft.com), select the correct directory, and navigate to **Entra ID > App registrations > New registration**.

Configure:

| Setting | Value |
| --- | --- |
| Name | `Example Web API` |
| Supported account types | **Accounts in this organizational directory only** |
| Redirect URI platform | **Web** |
| Redirect URI | `https://portal.example.com/api/auth/callback` |

After registration, record the **Application (client) ID** and **Directory (tenant) ID** from **Overview**.

### Configure authentication deliberately

Under **Authentication**, verify that the callback is registered as a **Web** redirect URI.

For this server-side authorization code design:

- Leave the implicit-grant **Access tokens** and **ID tokens** checkboxes disabled.
- Leave **Allow public client flows** disabled.
- Do not configure the backend callback as a SPA redirect.
- Add a front-channel logout URL only if the application implements that protocol endpoint.

Leaving implicit ID-token issuance disabled does not prevent an authorization code flow from returning an ID token after the backend redeems its code.

For development, Entra supports documented localhost redirect exceptions, for example:

```text
http://localhost:3001/api/auth/callback
```

Use the application's actual callback, including its path and case. Do not assume production HTTPS and development localhost URLs are interchangeable. Microsoft's [redirect URI reference](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url) explains platform-specific matching rules.

## 4. Give the API its own audience and delegated scope

In the API registration, open **Expose an API**.

### Set the Application ID URI

Set:

```text
api://<API_APPLICATION_ID>
```

This is an OAuth resource identifier, not a network address. It does not create an endpoint, DNS record, or TLS certificate.

### Add the delegated scope

Select **Add a scope**:

| Field | Example |
| --- | --- |
| Scope name | `Api.Access` |
| Who can consent? | **Admins only** |
| Admin consent display name | `Access the business API as the signed-in user` |
| Admin consent description | `Allow this client to use the API within the user's assigned application roles and downstream permissions.` |
| State | **Enabled** |

The resulting scope is:

```text
api://<API_APPLICATION_ID>/Api.Access
```

Record the scope's definition GUID if you manage permissions through a manifest or Microsoft Graph.

### Request v2 access tokens for this resource

Open **Manifest** and set:

```json
{
  "api": {
    "requestedAccessTokenVersion": 2
  }
}
```

This is a fragment to merge into the existing manifest, not a replacement for its entire `api` object.

The setting belongs to the application **receiving** the access token. Calling a `/v2.0` authorization or token endpoint does not, by itself, guarantee a v2 access token for every resource.

For a v2 token issued to this custom API, the expected `aud` is its application/client GUID. Do not confuse it with the full scope URI:

```text
Requested scope: api://<API_APPLICATION_ID>/Api.Access
Expected aud:   <API_APPLICATION_ID>
Expected scp:   Api.Access
```

This article selects v2 tokens for the custom resources; it is not a claim that OBO universally requires v2 tokens. You also cannot change Microsoft Graph's token format by editing your own registrations. See the [`apiApplication` resource reference](https://learn.microsoft.com/en-us/graph/api/resources/apiapplication?view=graph-rest-1.0).

## 5. Define user roles on the API

Scopes and roles answer different questions:

- **Scope:** Has this client been permitted to call the API on a user's behalf?
- **Role:** What is this user allowed to do inside the application?

Under the API registration's **App roles**, create:

| Display name | Allowed member types | Value | Enabled |
| --- | --- | --- | --- |
| API Viewer | **Users/Groups** | `Api.Viewer` | Yes |
| API Administrator | **Users/Groups** | `Api.Admin` | Yes |

Use separate, unique role-definition GUIDs.

A corresponding manifest example is:

```json
{
  "appRoles": [
    {
      "allowedMemberTypes": ["User"],
      "description": "Read application data within the user's permitted access.",
      "displayName": "API Viewer",
      "id": "66666666-6666-6666-6666-666666666666",
      "isEnabled": true,
      "value": "Api.Viewer"
    },
    {
      "allowedMemberTypes": ["User"],
      "description": "Perform supported administrative application operations.",
      "displayName": "API Administrator",
      "id": "77777777-7777-7777-7777-777777777777",
      "isEnabled": true,
      "value": "Api.Admin"
    }
  ]
}
```

The manifest represents **Users/Groups** as `"User"`. Do not add `"Application"` merely to make a permission appear in another portal screen: that defines an app-only permission model, which is not this delegated-user design.

Entra does not infer a hierarchy from role names. If administrators should inherit viewer operations, the API must implement that rule.

### Assign people through the Enterprise application

An app registration defines the application. Its **Enterprise application**, or service principal, controls its use in this tenant.

Open **Enterprise applications > Example Web API**:

1. Under **Properties**, keep user sign-in enabled.
2. Set **Assignment required?** to **Yes** for this restricted enterprise application.
3. Under **Users and groups**, assign approved users or groups to the appropriate API role.
4. Test with a fresh sign-in after changing assignments.

Creating a role definition does not assign anyone to it. Assigning an API role on a different Enterprise application does not make that role appear in an access token for this API.

Group-based application assignment requires appropriate Entra licensing, and nested group assignments do not cascade. Direct user assignment is useful for initial verification. See [application assignments](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal).

## 6. Add downstream permissions to the API, not the MCP gateway

If the API calls Microsoft Graph or another provider, configure those dependencies under **Example Web API > API permissions**.

Choose **Delegated permissions** for operations performed as a user. Add only the permissions the implemented features require.

Examples for a directory or Microsoft 365 administration application include:

| Feature | Possible delegated permission |
| --- | --- |
| Basic directory user lookup | Microsoft Graph `User.ReadBasic.All` |
| User and license synchronization | Microsoft Graph `User.Read.All` |
| Group lookup | Microsoft Graph `Group.Read.All` |
| Subscription/service-plan information | Microsoft Graph `LicenseAssignment.Read.All` |
| Usage reporting | Microsoft Graph `Reports.Read.All` |
| Package inventory versus package changes | Microsoft Graph `CopilotPackages.Read.All` versus `CopilotPackages.ReadWrite.All` |
| Agent identity lookup | Microsoft Graph `AgentIdentity.Read.All` |
| Audit search or threat hunting | Microsoft Graph `AuditLogsQuery.Read.All` or `ThreatHunting.Read.All` |
| Power Platform resource queries | Power Platform `ResourceQuery.Resources.Read` |
| Copilot Studio administrative actions | Power Platform `CopilotStudio.AdminActions.Invoke` |

These are feature examples, **not a permission bundle to grant by default**. Verify each provider's current permission reference, supported delegated behavior, and your application's contract. Some implementations also use a basic directory permission for identity proof even when the visible feature does not query user records.

For sign-in, request the OpenID Connect scopes the application needs, typically `openid`, `profile`, and `offline_access`. Add their corresponding delegated permission entries when declaring the application's consent requirements. `User.Read` is not a universal prerequisite for login; it is needed when the application actually uses the Graph operations that require it.

Then select **Grant admin consent for the tenant**, review the requested permissions, and verify their status.

Four things remain separate:

1. A permission declared in **API permissions**.
2. Consent granted for that permission.
3. The signed-in user's application and provider roles.
4. The provider's licensing, environment access, and other restrictions.

An API administrator role does not automatically make the user a Microsoft 365 or Power Platform administrator. Similarly, consent to a delegated write scope does not guarantee every signed-in user can perform the corresponding provider operation.

If a separate workload genuinely requires unattended app-only access, design and govern that workload explicitly. Do not add application permissions as a workaround for a failing delegated OBO flow.

## 7. Register the MCP gateway as a second confidential application

Create another app registration:

| Setting | Value |
| --- | --- |
| Name | `Example MCP Gateway` |
| Supported account types | **Accounts in this organizational directory only** |
| Redirect URI platform | **Web** |
| Redirect URI | `https://mcp.example.com/auth/callback` |

Record its **own** client ID. It must not be the API's client ID.

Under **Authentication**, again leave implicit grants and public-client flows disabled. A desktop MCP consumer may be a public OAuth client, but the **gateway's Entra application** is a confidential server-side client.

For the common proxy layout:

```text
Public MCP endpoint: https://mcp.example.com/mcp
Entra callback:      https://mcp.example.com/auth/callback
```

The callback is at the gateway origin's configured callback path. It is not automatically `/mcp/auth/callback`.

### Expose the MCP resource scope

Under **Expose an API**, set:

```text
Application ID URI: api://<MCP_APPLICATION_ID>
Scope name:         Mcp.Access
Who can consent:    Admins only
State:              Enabled
```

Use a clear consent description, such as permission to connect to the MCP gateway as the signed-in user. Record this scope's GUID separately from the API scope's GUID.

Set **Manifest > `api.requestedAccessTokenVersion`** to `2` on this registration too.

The upstream OAuth request should ask for:

```text
api://<MCP_APPLICATION_ID>/Mcp.Access
openid
profile
offline_access
```

The Entra access token obtained by the gateway must target the **MCP application**. Requesting a Graph token instead would leave the gateway without the MCP-audience assertion required for its first OBO exchange.

FastMCP's Azure provider supports this custom-resource scope pattern; its `required_scopes` are the unprefixed names, with the Application ID URI configured separately. See the [Azure integration documentation](https://gofastmcp.com/integrations/azure).

## 8. Configure the MCP application's delegated permissions and consent

The gateway needs permission to obtain a token for the business API.

In **Example MCP Gateway > API permissions**:

1. Select **Add a permission > My APIs**.
2. Select **Example Web API**.
3. Choose **Delegated permissions**.
4. Select `Api.Access`.
5. Add the permission.
6. Grant administrator consent.

If the API is not visible, verify the directory, registration ownership/access, and the exposed scope's enabled state. Search by application ID rather than assuming the display name is unique.

### Do not forget consent for the MCP sign-in scope itself

In this proxy design, the MCP registration is both a resource and the confidential client requesting its own resource scope. Consent to `Api.Access` does not also consent to `Mcp.Access`.

Include the MCP application's own delegated `Mcp.Access` permission in the configured consent set and grant administrator consent for it. If the portal does not offer the self-resource in its API picker, declare that permission through the manifest or Microsoft Graph.

For example, the MCP application's `requiredResourceAccess` can contain:

```json
{
  "requiredResourceAccess": [
    {
      "resourceAppId": "22222222-2222-2222-2222-222222222222",
      "resourceAccess": [
        {
          "id": "44444444-4444-4444-4444-444444444444",
          "type": "Scope"
        }
      ]
    },
    {
      "resourceAppId": "33333333-3333-3333-3333-333333333333",
      "resourceAccess": [
        {
          "id": "55555555-5555-5555-5555-555555555555",
          "type": "Scope"
        }
      ]
    }
  ]
}
```

Here, `4444...` represents the actual definition ID of `Api.Access`, and `5555...` represents the actual definition ID of `Mcp.Access`. They are not client IDs. Replace all synthetic IDs, merge existing permission entries, and then complete administrator consent. Editing `requiredResourceAccess` alone does not grant anything.

OIDC permission declarations can coexist with these entries. Do not remove existing required OIDC permissions when adding the two custom-resource permissions.

### Understand preauthorization without treating it as a firewall

Under **Example Web API > Expose an API > Authorized client applications**, you can preauthorize the MCP application's client ID for `Api.Access`.

This is consent configuration. It is **not** a complete calling-client allowlist. The API should still validate the incoming token's `azp` and allow only the intended gateway client ID for this integration.

The related manifest settings serve different purposes:

| Setting | Purpose |
| --- | --- |
| `api.oauth2PermissionScopes` | Defines the scopes a resource exposes |
| `requiredResourceAccess` | Declares the permissions a client requests from resources |
| `api.preAuthorizedApplications` | Preauthorizes specified client/scope combinations |
| `api.knownClientApplications` | Supports bundled consent for a multi-part solution registered in the same tenant |

For an administrator-provisioned deployment, explicit permission declarations and tenant consent are usually easier to reason about than relying on consent bundling. Do not add `knownClientApplications` simply because the architecture has two services.

### Decide whether MCP sign-in also requires assignment

Open **Enterprise applications > Example MCP Gateway > Properties**.

For a restricted internal deployment, set **Assignment required?** to **Yes** and assign the approved users/groups under **Users and groups**. If the gateway defines no app roles, its assignment can be **Default Access**.

This assignment controls access to the MCP application. It does not replace the users' Viewer/Admin assignments on the API Enterprise application. A user may need assignment to both.

Tenant-wide consent does not mean every user should be allowed to use the service. Consent and user assignment are independent controls.

## 9. Create separate confidential credentials

Each server needs its own credential for the token exchanges it performs:

| Credential | Used by |
| --- | --- |
| API application's credential | Web sign-in code redemption and API-to-provider token acquisition |
| MCP application's credential | MCP upstream sign-in code redemption and MCP-to-API OBO |

For a client secret, open each registration's **Certificates & secrets > New client secret**:

1. Choose a description and expiry according to organizational policy.
2. Create the credential.
3. Copy its **Value** immediately.
4. Save it directly in the server's approved secret store.
5. Record the expiry and rotation owner without recording the value in a runbook.

The secret value is not the secret ID. Do not reuse the API credential in the MCP configuration.

Certificates or an explicitly supported workload-federation/client-assertion setup may be preferable in production. The application library must actually support the chosen method. Enabling an Azure managed identity does not automatically configure that identity to authenticate as either registered OAuth application.

There may also be MCP-specific signing and encryption keys. These protect gateway-issued tokens and persisted OAuth credentials. They are **not Entra client secrets**, and they are not created under **Certificates & secrets**. A deployment wizard can generate and store them independently. Preserve them across restarts and ordinary credential rotation.

## 10. Keep the three callback types separate

This is one of the easiest setup errors to make:

| Callback | Example | Configure it in |
| --- | --- | --- |
| Browser application's Entra return | `https://portal.example.com/api/auth/callback` | API registration's **Authentication > Web** |
| Gateway's Entra return | `https://mcp.example.com/auth/callback` | MCP registration's **Authentication > Web** |
| MCP consumer's OAuth return | `https://client.example.com/oauth/callback`, or an exact loopback URL | MCP gateway's downstream client/redirect policy |

With an OAuth proxy, the consumer returns to the gateway's OAuth system, while Entra returns to the gateway's fixed upstream callback. You do not add every editor, command-line tool, or hosted assistant callback to the gateway's Entra registration.

Likewise, Entra does not need a new registration for every dynamically registered downstream MCP consumer in this design. That registration occurs at the gateway, not at Entra.

Supporting multiple consumers therefore does **not** mean setting an Entra client ID to `*`. The upstream MCP application identity and the API's trusted calling-application identity remain concrete GUIDs.

Client compatibility still matters: a consumer must implement the OAuth discovery, PKCE, resource-indicator, refresh, and redirect behavior required by the gateway. An arbitrary redirect URL or unsupported client authentication flow does not become safe merely because registration is dynamic.

## 11. Wire the deployment to the same identity model

The portal configuration and application configuration must agree:

| Runtime component | Non-secret configuration |
| --- | --- |
| Web backend/API | Tenant ID, API client ID, exact browser callback, API scope/role values |
| API bearer validator | Tenant-specific issuer, API client-ID audience, required delegated scope, trusted MCP calling client ID |
| MCP gateway | Same tenant ID, MCP client ID, API client ID, exact public MCP resource, upstream callback, downstream callback policy |
| Provider token acquisition | Resource-specific scopes and the credential belonging to the application performing the exchange |

Store each credential separately; do not place values in client configuration examples.

Use tenant-specific endpoints:

```text
Authority: https://login.microsoftonline.com/<TENANT_ID>
Authorize: https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/authorize
Token:     https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/token
Issuer:    https://login.microsoftonline.com/<TENANT_ID>/v2.0
```

The issuer above is for this article's public-cloud, v2, single-tenant configuration. Sovereign clouds require their corresponding authority and metadata.

The MCP public resource URL is separate from the internal API network address. Neither the API's internal service hostname nor an `api://` Application ID URI should replace the public MCP resource in downstream OAuth discovery.

Entra registration does not configure HTTPS ingress, DNS, trusted reverse proxies, or application callback handlers. Those are separate deployment responsibilities.

## 12. Verify both token exchanges, not just the sign-in page

A successful login proves only part of the configuration.

### First exchange: MCP gateway to API

The gateway obtains an Entra access token with:

```text
aud = <MCP_APPLICATION_ID>
scp includes Mcp.Access
```

It then authenticates to Entra as the MCP application and performs an OBO exchange:

```text
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
requested_token_use=on_behalf_of
client_id=<MCP_APPLICATION_ID>
assertion=<ENTRA_ACCESS_TOKEN_FOR_MCP>
scope=api://<API_APPLICATION_ID>/Api.Access
```

The request also includes the MCP application's supported confidential authentication, such as its client secret or client assertion.

The resulting token should identify the API as its audience and the MCP application as its calling client. An illustrative claims subset is:

```json
{
  "ver": "2.0",
  "iss": "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0",
  "tid": "11111111-1111-1111-1111-111111111111",
  "aud": "22222222-2222-2222-2222-222222222222",
  "azp": "33333333-3333-3333-3333-333333333333",
  "oid": "88888888-8888-8888-8888-888888888888",
  "scp": "Api.Access",
  "roles": ["Api.Viewer"]
}
```

This is not a complete or usable token. Real validation must verify signatures, issuer, tenant, audience, time bounds, delegated scope, calling client, and application authorization.

A user can have both `scp` and `roles` in an access token. A user-role claim is not the same thing as an app-only application permission. Do not discard the distinction.

### Second exchange: API to downstream service

The API receives its own audience-bound token and performs another OBO exchange using **the API application's credential**, requesting the provider scopes it needs.

The API cannot redeem an MCP-audience token as if it were issued to the API. Nor can the gateway use the API's secret with its MCP-audience assertion.

Acquire tokens separately for different downstream resources. A Graph token is not a Power Platform token, and a scope request should not mix arbitrary permissions from different resource APIs into one access token.

Depending on the library and consent model, requests may use explicit scopes or a resource's `.default` scope. `.default` refers to configured permissions; it does not grant missing consent or bypass user authorization.

### Distinguish Entra tokens from gateway-issued tokens

An OAuth-proxy gateway may issue its own MCP access token to the consumer and retain the associated Entra credentials server-side.

That gateway token is not an Entra OBO assertion. The gateway must use the correct validated upstream Entra token for the first exchange. The consumer should never need either server's confidential credential.

Microsoft documents the assertion-audience requirement and consent dependencies in the [OBO protocol reference](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow).

### Test authorization failures as well as successful calls

Before considering setup complete, verify:

1. An assigned Viewer can sign in through the web application.
2. The same user can authenticate through a compatible MCP consumer.
3. Both paths return equivalent authorized API data.
4. The Viewer cannot perform an Admin-only operation.
5. An approved Admin can perform a suitably bounded operation when provider permissions also allow it.
6. An unassigned or incorrectly assigned user is denied.
7. Tokens for the wrong audience, tenant, scope, or calling client are rejected.
8. Refresh and reconnect work without substituting a different user.
9. Both OBO hops work without first warming an unrelated browser session.

Use local, trusted diagnostics. Do not paste live access tokens, refresh tokens, authorization codes, or client secrets into online token decoders, chat, or public issue reports. Decoding a JWT locally is useful for inspection but is not cryptographic validation.

## 13. Troubleshoot the missing boundary

| Symptom | Check first |
| --- | --- |
| `AADSTS50011` / redirect mismatch | The correct registration, **Web** platform, and actual callback URL |
| `invalid_client`, `AADSTS7000215`, or expired-credential errors | Secret **value**, expiry, tenant, and which application owns the credential |
| `AADSTS65001` / consent required | The actual client-to-resource delegated grant; MCP self-scope, MCP-to-API, and API-to-provider consent are separate |
| API does not appear under **My APIs** | Correct tenant, registration access/ownership, and enabled exposed scope |
| Token has unexpected version or audience | Resource registration's `api.requestedAccessTokenVersion`, requested resource, and validator expectations |
| Browser login works but MCP gets API 403 | API user-role assignment, `Api.Access`, allowed MCP `azp`, and the API integration configuration |
| API token is valid but Graph/another provider rejects the call | API application's provider permissions, admin consent, user/provider role, license, and resource audience |
| User is blocked despite tenant-wide consent | Enterprise application assignment and Conditional Access |
| Roles are absent or outdated | Assignment on the API Enterprise application, exact role value, fresh tokens/session, and assignment propagation |
| Hosted client works but a CLI fails | Gateway callback allowlist, exact loopback host/port/path, and the client's OAuth implementation |

Conditional Access, MFA, authentication strength, and guest-access policy can affect either sign-in or downstream token acquisition. Examine the relevant Entra sign-in logs and correlation IDs. Where supported, propagate an interaction/claims challenge so the user can reauthenticate; do not disable those policies to make OBO appear successful.

For B2B guests, assignments and authorization must be evaluated in the resource tenant. Use tenant/object identifiers rather than treating an email address as a stable authorization key.

## 14. Final Entra configuration checklist

### API registration

- [ ] Correct tenant, environment, application owners, and single-tenant account type.
- [ ] Actual browser callback registered as **Web**.
- [ ] Implicit grants and public-client flows disabled for this confidential backend.
- [ ] Application ID URI set to `api://<API_APPLICATION_ID>`.
- [ ] Required API delegated scope enabled with the application's exact scope value.
- [ ] `api.requestedAccessTokenVersion` set to `2`.
- [ ] Viewer/Admin user roles enabled with exact application-required values.
- [ ] API Enterprise application sign-in enabled and assignment required.
- [ ] Approved users/groups assigned to the API roles.
- [ ] Only implemented downstream delegated permissions configured.
- [ ] Administrator consent granted for the required downstream/OIDC permissions.
- [ ] API confidential credential stored securely with an expiry/rotation owner.

### MCP registration

- [ ] Separate client ID in the intended tenant and environment.
- [ ] Actual upstream callback registered as **Web**, not the consumer callbacks.
- [ ] Implicit grants and public-client flows disabled.
- [ ] Application ID URI set to `api://<MCP_APPLICATION_ID>`.
- [ ] `Mcp.Access` or the implementation's exact MCP scope enabled.
- [ ] `api.requestedAccessTokenVersion` set to `2`.
- [ ] Delegated API permission configured for the business API.
- [ ] MCP sign-in scope and MCP-to-API permission administrator-consented.
- [ ] Optional API preauthorization understood as consent configuration, not an API firewall.
- [ ] MCP Enterprise application assignments completed if assignment is required.
- [ ] Separate MCP confidential credential stored securely with an expiry/rotation owner.

### End-to-end deployment

- [ ] Tenant, audiences, scopes, role values, callback URLs, and trusted caller ID agree with application configuration.
- [ ] Downstream MCP callbacks configured at the gateway, without wildcarding the Entra application identity.
- [ ] Public HTTPS and proxy configuration preserve the intended external identity.
- [ ] Gateway signing/encryption keys are managed separately from Entra credentials.
- [ ] Both OBO exchanges, least-privilege access, denial cases, refresh, and reconnect verified.
- [ ] Provider-specific roles, licensing, and Conditional Access requirements understood.

## Closing thought

The goal is not merely two successful sign-in screens. It is a continuous, verifiable chain: a specific user, connecting through a specific client application, receiving a token for a specific resource, and remaining within that user's permitted operations at every hop.

Once those boundaries are explicit, the portal settings become easier to reason about. Scopes describe delegation, roles describe application privileges, consent approves permission use, assignments control user access, and credentials identify the server making each exchange. None is a substitute for the others.

## References

- [Microsoft: Configure an application to expose a web API](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-expose-web-apis)
- [Microsoft: Configure client permissions to a web API](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-access-web-apis)
- [Microsoft Graph: API application properties, token version, and preauthorization](https://learn.microsoft.com/en-us/graph/api/resources/apiapplication?view=graph-rest-1.0)
- [Microsoft: Define app roles and receive role claims](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)
- [Microsoft: Assign users and groups to an Enterprise application](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)
- [Microsoft: Grant tenant-wide administrator consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)
- [Microsoft: Redirect URI requirements](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)
- [Microsoft: OAuth 2.0 on-behalf-of flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow)
- [Microsoft: Access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)
- [FastMCP: Azure / Microsoft Entra OAuth integration](https://gofastmcp.com/integrations/azure)
- [FastMCP: OAuth proxy architecture](https://gofastmcp.com/servers/auth/oauth-proxy)
