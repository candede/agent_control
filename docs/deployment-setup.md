# Deployment setup

This guide configures Microsoft Entra ID and starts Agent Control locally.

The [MCP integration contract](mcp-integration.md) documents the separate,
locally implemented delegated API integration, registration audiences, secret
ownership and independent API/web operation. It is not permission to
provision MCP or change an existing production project.

## Optional delegated API binding

No MCP/Python package, service or registration is needed for the web app. Existing
tenant profiles omit `integration` and browser sign-in/startup remains unchanged.
The strict API and existing deployment registry parsers accept this optional
non-secret object inside an **already configured** tenant profile:

```json
{
  "integration": {
    "clientId": "33333333-3333-3333-3333-333333333333",
    "audience": "22222222-2222-2222-2222-222222222222",
    "scope": "AgentControl.Access"
  }
}
```

These are synthetic GUIDs: `audience` must be that profile's exact existing
API `clientId`, and the integration client must be distinct. Missing integration
means bearer admission disabled; null/partial/unknown fields, other scopes or
conflicting bindings fail explicitly. Local onboarding preserves the object
without adding consent prompts; metadata contains no client secret. Existing
`TENANTS_JSON`/`TENANTS_JSON_FILE` ownership and protected file handling remain.

For a separately approved later registration change, the existing API exposes
`api://<apiClientId>/AgentControl.Access`, uses v2 access tokens
(`api.requestedAccessTokenVersion=2`), and retains Viewer/Admin **user/group**
assignments. A distinct tenant-specific integration confidential client receives
that delegated scope through **administrator-managed consent**. For example,
an API scope declaration (merge with existing configuration, never replace it):

```json
{
  "id": "44444444-4444-4444-4444-444444444444",
  "value": "AgentControl.Access",
  "type": "Admin",
  "isEnabled": true,
  "adminConsentDisplayName": "Use Agent Control as a signed-in user",
  "adminConsentDescription": "Use assigned Agent Control roles and existing delegated provider permissions."
}
```

The API validates v2 token audience as the **API client GUID**, not an audience
array, MCP resource token, ID token or `api://` scope URI. API-owned OBO uses
existing admin-consented Graph `User.ReadBasic.All`/OIDC metadata to prove native
and guest private identity, without a Graph data read or prior portal login.
Actual live account/client-info continuity is not yet proven; unsupported
responses stay closed. No runtime consent writer, app-only grant, directory
lookup fallback or identity migration is supplied. See the
[integration contract](mcp-integration.md#current-principal-and-credential-foundation)
for deadlines, role freshness and claims challenges, and its
[canonical integration](mcp-integration.md#current-canonical-integration)
for active HTTP/worker boundaries.
These examples authorize no tenant setup, grant or deployment.

Existing routes accept delegated bearer authority only where the frozen map
allows it. Do not combine Authorization with the browser session cookie or
provide identity/origin headers as authority. Browser-only sign-in, import,
configuration and downloads retain cookie Origin/CSRF protections.
Provider permissions still require administrator-managed consent and independent
capability readiness. Long-running work pauses when its initiating source
expires or becomes stale; obtain fresh same-account authorization and explicitly
resume unsent work. Restart does not recover credentials from portal caches,
sessions or durable jobs. Sent-unknown writes must reconcile before resend.
After account-wide revocation, obtain an API token with issuance strictly later
than the durable cutoff (a later second if needed); a new token with unchanged
`iat` is not new authority. Supported native/guest recovery requires no portal
login. Old grants, selections and workers do not inherit the new request's epoch.
The current schema includes the issuance cutoff directly; see
[schema/private identity](mcp-integration.md#sourceschemaprivate-identity-baseline).
Installation supports empty/current schema only. An incompatible owned database
requires explicit target/data-loss confirmation for reset; ordinary startup
does not convert it. After verified installation/reset, normal operation starts
without a provider-enable or release-acceptance step.

Omitted integration configuration disables bearer admission without affecting
browser startup. Configured bearer requests require actual supported token/
identity proof, not a qualification artifact. This guide claims no live OBO,
provider or MCP deployment result.

## Prerequisites

- PowerShell 7
- Docker Desktop, or Docker Engine with Compose v2
- Git and a checkout of this repository
- An Entra administrator who can register applications and grant consent

## Configure the Entra application

Complete these steps once for the tenant. The local configuration runs on
`localhost`.

### 1. Register Agent Control

1. Open the **Microsoft Entra admin center**.
2. Go to **Identity > Applications > App registrations**.
3. Select **New registration**.
4. Enter `Agent Control` as the name.
5. Under **Supported account types**, select **Accounts in this organizational
   directory only**.
6. Under **Redirect URI**, select **Web** and enter:

   ```text
   http://localhost:3001/api/auth/callback
   ```

7. Select **Register**.

On the registration's **Overview** page, copy:

- **Directory (tenant) ID**
- **Application (client) ID**

You will enter both values in the Agent Control setup wizard.

### 2. Create a client secret

1. Open **Certificates & secrets** in the new app registration.
2. Select **New client secret**.
3. Enter a description and choose an expiry that follows your organization's
   credential policy.
4. Select **Add**.
5. Copy the secret **Value** immediately.

Store the value securely. The setup wizard needs the secret value, not the
secret ID.

### 3. Add the app roles

Import only the `appRoles` array from
[`infra/entra-app-manifest.json`](../infra/entra-app-manifest.json), or create
these roles manually:

| Role | Use |
| --- | --- |
| `AgentControl.Viewer` | View inventory, reports, and investigations |
| `AgentControl.Admin` | Viewer access plus supported changes, imports, and configuration |

The roles must be enabled and allow **Users/Groups**. Admin already includes
Viewer access, so each user or group needs only one role.

### 4. Require assignment

Open **Enterprise applications > your application > Properties** and set
**Assignment required?** to **Yes**.

Assign each approved user or group either **Agent Control Viewer** or
**Agent Control Admin**. Sign out and back in after changing assignments.

### 5. Add API permissions

Open **App registrations > your application > API permissions**. Add only the
permissions needed for the features you plan to use.

| API | Delegated permission | Feature |
| --- | --- | --- |
| Microsoft Graph / OpenID Connect | `openid`, `profile`, `offline_access` | Sign-in and session renewal |
| Microsoft Graph | `CopilotPackages.Read.All` | Package inventory |
| Microsoft Graph | `CopilotPackages.ReadWrite.All` | Package availability, assignments, block, and unblock |
| Microsoft Graph | `User.ReadBasic.All` | Basic user lookup |
| Microsoft Graph | `Group.Read.All` | Group lookup |
| Microsoft Graph | `User.Read.All` | User and license synchronization |
| Microsoft Graph | `LicenseAssignment.Read.All` | Product and service-plan catalog |
| Microsoft Graph | `Reports.Read.All` | Microsoft 365 Copilot activity |
| Microsoft Graph | `AgentIdentity.Read.All` | Copilot Studio identity matching |
| Microsoft Graph | `AuditLogsQuery.Read.All` | Purview audit search |
| Microsoft Graph | `ThreatHunting.Read.All` | Defender and Agent 365 hunting |
| Power Platform | `ResourceQuery.Resources.Read` | Copilot Studio agents and environments |
| Power Platform | `CopilotStudio.AdminActions.Invoke` | Quarantine status and changes |

The Power Platform application ID is:

```text
8578e004-a5c6-46e7-913e-12f58912df43
```

Select **Grant admin consent** after adding permissions. Agent Control does not
request these grants during sign-in.

Microsoft roles and licensing are separate from API permissions. See
[Microsoft roles and permissions](user-roles-and-permissions.md).

## Start locally

Run from the repository root:

```powershell
pwsh ./deploy-local.ps1 start
```

The first start asks for the tenant ID, client ID, client secret, accepted
sign-in domains such as `contoso.com`, and local port. Use the values copied
from the Entra app registration. Configuration is saved under
`.local/agent-control/`; no `.env` file is required.

Open:

```text
http://localhost:3001
```

Use the port selected in the wizard if it differs from `3001`.

### Check permissions and collect data

After signing in:

1. Open **Permissions** and select **Check status**.
2. Resolve any missing role, permission, consent, or license.
3. Open **Sync** and refresh the sources you want to use.

### Temporary two-agent sharing investigation

For the current BRD Review Analyst / Enterprise Visual Architect comparison,
enable the removable backend-only diagnostic explicitly:

```powershell
pwsh ./deploy-local.ps1 start -Project seha -AgentSharingDiagnostics
```

Use your existing project name. No database reset or new API consent is needed
solely for this diagnostic. Sign in as an Agent Control Admin and manually run
**Sync all** or sync **Graph packages**. After successful Graph catalog
publication, the separate function requests only these two agents in tenant
`5dc17551-d2fb-4e89-93da-178b52154818`:

- Exact Graph package details from both `v1.0` and `beta`, without `$select`.
- Power Platform ResourceQuery responses, server-filtered by native agent ID,
  tenant, environment and resource type, then independently scope-validated.
  The POST is a read-only resource query, not a settings change.

Six response artifacts retain unprojected **parsed JSON**, including unknown
properties and missing/null/empty distinctions. They are not byte-for-byte wire
captures. Credential-named fields and the active access token are redacted.
Request headers, cookies and authentication responses are never captured.
Responses that fail identity/scope validation are rejected rather than saved.
Denied or missing targets are recorded explicitly in the manifest.

Files persist privately on the host under
`.local/<project>/agent-sharing-diagnostics/<capture-id>/`, mounted at
`/run/agent-sharing-diagnostics/<capture-id>/` in the app container. Directory
permissions are `0700`, file permissions `0600`. Captures may contain agent
instructions and confidential authoring content: do not commit, publish or
attach them to issues. There is no raw-data HTTP endpoint, CSV export or database
schema change.

Ordinary container logs contain only safe operational metadata. Look for
`agent_sharing_diagnostic_started`, `agent_sharing_diagnostic_response_saved`,
`agent_sharing_diagnostic_response_failed`, and
`agent_sharing_diagnostic_finished`. The `jobId` is the private capture directory
name; `runId` links it to the manual sync. `manifest.json` lists endpoints,
timestamps, filenames and explicit success/failure outcomes. A started-only
manifest means collection was interrupted before finalization.

The regular sync's success is **not** diagnostic success. This optional
investigation does not change normal inventory publication or its status.
Check the diagnostic's own finish event and final manifest. Dataverse is
explicitly recorded as not attempted because there is no authenticated
Dataverse discovery/read client; `bot.accesscontrolpolicy` is not a verified
mapping to owner-controlled org-wide chat access.

Automatic sign-in refresh, polling, detail-only sync and capability checks do
not trigger capture. Manual Graph retries can trigger another capture. The
normal **Sync complete** banner may describe an automatic run and is not a
diagnostic trigger. When diagnostics are enabled but no capture exists, click
**Sync Graph packages** after the current run finishes; do not wait for another
automatic refresh or use **Sync package details** to trigger the investigation.
The function allows one capture at a time, a three-minute deadline, two-million-byte
responses/files and **three capture directories total** (about 36 MB of response
data maximum). It never silently overwrites or deletes earlier evidence.
Sign-out, cancellation, shutdown and revoked authorization fence collection.
Quota, permission and disk errors are explicit diagnostic failures.

Redeploy without `-AgentSharingDiagnostics` to disable it. This does not delete
existing evidence. After analysis, stop the app and delete only the specific
owned capture directories under the path above; do not remove the project
state, secrets or database directories. The existing `ENABLE_RAW_PROVIDER_DATA`
runtime prohibition remains in force; Azure does not support this temporary
local diagnostic.

## Change local settings

```powershell
pwsh ./deploy-local.ps1 edit-config
pwsh ./deploy-local.ps1 start
```

Register the new callback URL in every Entra app registration if the public URL
or port changes.

Use a separate project for an independent installation:

```powershell
pwsh ./deploy-local.ps1 start -Project contoso
```

Project state is stored under `.local/<project>/`.

### Recover from failed database initialization

An initialization failure leaves the application in maintenance. If an explicit
`-DbReset` already succeeded, the old application data has already been deleted;
initialization may still have created the current schema before verification
failed.

After correcting the reported failure, retry without another reset:

```powershell
pwsh ./deploy-local.ps1 start -Project contoso
```

Initialization accepts either a fresh database or this build's current schema.
A retry preserves the current schema and existing secrets. Use `-DbReset` only
when an incompatible schema requires an intentional, destructive reset; do not
repeat it merely because initialization failed.

## Configure multiple tenants

Add each tenant through the configuration wizard:

```powershell
pwsh ./deploy-local.ps1 edit-config
```

Each tenant needs its own app registration, client secret, accepted domains,
app-role assignments, API permissions, and admin consent. All registrations use
the same callback URL for the deployment.

Users enter their work or school username. Agent Control routes sign-in by an
exact configured domain. Domains cannot overlap and do not include subdomains
automatically.

## Run software checks

```powershell
pwsh ./deploy-local.ps1 check
```

To check and deploy the same source snapshot:

```powershell
pwsh ./deploy-local.ps1 start -ForceChecks
```

Normal `start` validates configuration and application readiness but does not
run the full test suite.

## Deploy to Azure

Production deployment uses `deploy-azure.ps1`. Follow the
[Azure deployment guide](azure-production-deployment.md).
