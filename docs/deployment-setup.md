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

The [current local qualification procedure](operations.md#current-release-qualification-for-deployment-testing)
rebuilds manifest-matching images and distinguishes real local SQL/container/
Azurite proof from unavailable Entra/provider/App Service proof. Follow the
ordinary configured `deploy-local.ps1 start/check/stop` lifecycle below only for
an explicitly authorized testing target. No qualification receipt enables reads
or controls at runtime, and these instructions do not authorize phase12 or an
existing production project.

## Local FastMCP foundation (phase 05)

Use the [current client-specific onboarding and workflow recipes](mcp-clients.md)
for exact downstream callbacks, discovery/resource/PKCE, DCR, supported client
editions, refresh, confirmation and proof limitations. The upstream Entra callback
below is different from the client's OAuth return URI.

The installable `mcp/` package now implements tenant-specific OAuth,
authenticated Streamable HTTP, encrypted OAuth state and a typed canonical API
adapter. Phases06–07 register124 typed saved-read, explicit collection,
investigation and exact shared/package/Studio control tools automatically.
See the [implemented catalog](mcp-integration.md#implemented-typed-business-catalog-phase-06)
for exact paging, output and delegated-only contracts, and
[exact controls](mcp-integration.md#implemented-exact-controls-phase-07) for
Admin/provider permissions, client confirmation, receipt expiry and non-replay.
The web app remains independent.
This section is source/setup guidance, not permission to register applications,
grant consent, deploy, reset storage or test customer accounts.

Use Python **3.14** and uv **0.12.17**. Install only through the approved feed;
there is no public-index fallback or automatic Python download:

```sh
cd mcp
UV_PYTHON_DOWNLOADS=never uv sync --frozen \
  --index-url https://packagefeedproxy.microsoft.io/pypi/simple
uv run --frozen --no-sync pytest
uv run --frozen --no-sync ruff check src tests
uv run --frozen --no-sync mypy src
```

The manifest pins direct dependencies and the build backend; `uv.lock` records
transitive versions, approved-feed source URLs and artifact hashes. If uv is
missing, its installation must also use
`python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple uv==0.12.17`.
Do not change the index or install unrelated tooling to work around a feed error.

Supply these settings directly through the operator's environment/secret
manager (the service does not load `.env` files):

| Setting | Required value |
| --- | --- |
| `MCP_TENANT_ID` | Exact configured Entra tenant GUID, never `common`/`organizations` |
| `MCP_CLIENT_ID` | Separate confidential MCP client/resource GUID |
| `MCP_API_CLIENT_ID` | Existing API client GUID; must differ from MCP |
| `MCP_API_ORIGIN` | One canonical HTTPS API origin, without path/query; exact loopback or single-label private HTTP service names support later internal Compose transport |
| `MCP_PUBLIC_URL` | Exact canonical HTTPS resource, for example `https://mcp.example.test/mcp`, without query/trailing slash |
| `MCP_ALLOWED_CLIENT_REDIRECT_URIS` | JSON array of 1–32 exact approved callbacks; HTTPS or exact HTTP loopback, never wildcards or permissive defaults |
| `MCP_CLIENT_SECRET_FILE` | Owned regular0600 UTF-8 file containing only the MCP confidential credential |
| `MCP_JWT_SIGNING_KEY_FILE` | Separate owned regular0600 file containing a canonical URL-safe base64 encoding of32 random bytes |
| `MCP_OAUTH_ENCRYPTION_KEY_FILE` | Separate owned regular0600 file containing a JSON array of1–3 independent Fernet keys, newest first |
| `MCP_OAUTH_STORAGE_PATH` | Absolute dedicated owned0700 persistent OAuth directory, e.g. `/var/lib/agent-control-mcp/oauth`, not the application data volume |

This table's secret files describe local/direct/Compose execution. The
[optional Azure profile](azure-production-deployment.md#optional-independent-mcp-app-service)
uses explicit `MCP_SECRET_SOURCE=app-service-key-vault`, three resolved native
Key Vault values and one prepared encrypted Blob object with an exact UAMI,
HTTPS/private endpoint and server-enforced data-blob lease instead. It never
automatically falls back between profiles. Missing object/lease, wrong binding,
unknown storage outcomes or unresolved references fail closed; local protected
file guards and maintained encryption are unchanged. See the Azure contract for
exact Blob settings, quotas, finite network/lease bounds and recovery.

Canonical URL spelling is enforced before readiness, including reserved endpoint
paths and default-port/host normalization. Secret files must be distinct and
signing/encryption/confidential material independent. No key or credential is
generated or derived automatically. No API/provider/SQL credentials enter MCP.

The MCP Entra resource exposes `api://<mcpClientId>/Mcp.Access`, requests v2
access tokens, and uses the exact **origin-root** redirect
`https://mcp.example.test/auth/callback`. The resource path `/mcp` is not appended
to this callback. Discovery, `/authorize`, `/token`, `/register`, `/consent`
and `/revoke` are on that origin root. Keep the API/browser callback separate.
Request only the MCP resource scope plus `openid profile offline_access`.
Administrator-managed API `AgentControl.Access` consent remains separate; no
Graph scope is mixed into MCP login. Both downstream authorize and token
requests must include the exact MCP resource; authorize requires S256 PKCE.
Consent uses the SDK's interactive, CSRF-bound OAuth flow. It is never a
release-acceptance file or runtime feature-enable ceremony.

With approved configuration in place, start the source service using
`uv run --frozen --no-sync agent-control-mcp`. It binds port8000; the configured
external HTTPS host/resource remain exact. Reverse proxy/TLS, container image,
mount lifecycle and deployment integration belong to08/10, not this source-only
phase. `/health` and `/ready` return bounded non-secret status. `/diagnostics`
requires bearer authorization on every call; protocol session IDs alone never
authorize a request.

Tests execute the actual pinned SDK against synthetic Entra/JWKS/API transports,
including full discovery/consent/code/PKCE/refresh flow and real request-local
metadata. The full Python suite also uses the checkout's existing Node/TypeScript
development dependencies to inspect backend DTOs without importing their runtime;
the Python service itself has no Node dependency. Tests open no provider/SQL
connection or listener and do not establish
live native/guest consent, client-host compatibility or deployment readiness.
The phase06 local check passed **339 Python cases**, strict source mypy and Ruff,
**176 existing API cases in seven suites**, and **473 browser cases in five
suites**. Backend/frontend typechecks and Knip also passed. Exact commands, source/lock
identities and unavailable live/SQL checks are in the
[phase completion record](../plans/fastmcp-integration/completions/06-mcp-read-tools.md).
Phase07's final local aggregate passed **501 Python cases**, **697 API cases
in13 suites** and **536 frontend cases in6 suites**, with strict Python checks,
both Node typechecks, Knip and offline lock validation. The
[control completion record](../plans/fastmcp-integration/completions/07-mcp-agent-controls.md)
separates those source/synthetic results from unavailable SQL-backed durability
and unauthorized live/provider/deployment checks.
The [security lifecycle](security-model.md#fastmcp-oauth-state-and-recovery)
defines restart, retention, revocation, rotation and reconnect.

## Optional local MCP container

MCP is absent from `compose.yaml`. Ordinary projects build/start only API/web
and PostgreSQL. The existing `deploy-local.ps1` owner includes
`compose.mcp.yaml` **only** when the project's optional `mcp` settings are
explicitly configured. There is no runtime enable/acceptance switch.
Malformed supplied configuration fails; no tenant is selected implicitly.
Do not apply these commands to an existing production project without its
separate exact-target authorization.

### Guided setup (recommended)

Use the same deployment wizard as the API, with an explicit MCP setup request:

```powershell
# Configure an existing API project without starting containers:
./deploy-local.ps1 edit-config -Project YOUR_PROJECT -ConfigureMcp
# Or complete API setup (if needed), configure MCP and start:
./deploy-local.ps1 start -Project YOUR_PROJECT -ConfigureMcp
```

The wizard lets you choose an existing API tenant profile, enter the **separate
MCP Entra application ID**, exact public HTTPS resource, allowed client callback
URLs and loopback port. It reads the MCP Entra **secret value** using hidden
input; obtain that credential from the MCP registration, not the API's secret
file. On first setup it generates independent cryptographically random signing
and encryption keys and saves all three protected files itself. No manual key
files or Python key-generation command are needed.

It also saves the matching `integration` binding in both the protected API tenant
registry and its non-secret metadata, preserving other profiles and refusing
to overwrite a different integration. It does **not** create Entra registrations,
permissions/consent, a public HTTPS endpoint or a reverse proxy. Complete the
Entra prerequisites above; register the MCP origin's `/auth/callback` as its Web
reply URL. Client callback URLs are different; see [client examples](mcp-clients.md).

If setup adds an API integration binding, it changes the API's trusted application
policy: `edit-config` drains the existing API, and the next `start` applies the
binding and clears old sessions. Use `start -ConfigureMcp` to combine setup,
build/preflight and application. Later MCP-only callback or credential edits do
not drain the API during configuration; apply them with the next normal `start`.

Running normally without MCP settings still does not ask for MCP credentials,
generate MCP keys or create an MCP container. `-ConfigureMcp` is only a setup
operation, not a runtime feature flag. Existing configured MCP starts normally
without it. It is accepted only by `start` and `edit-config`, not pinned releases.

### Settings file alternative

Copy [the local server settings example](../mcp/examples/local-settings.example.json)
to an operator-private location and replace the synthetic IDs and URL.
`tenantId` and `apiClientId` must select an existing API tenant profile.
`clientId` is the **MCP server's Entra registration**, not a downstream consumer
ID: it must remain a real GUID, never `*`.

Any compatible downstream MCP client may dynamically register; no vendor/client-ID
allowlist is required. This is the requested "any client" behavior, not anonymous
access: tenant, audience, delegated-user permissions, roles, PKCE and callback
validation still apply. Add the exact callbacks for the clients you intend to
use; accepting any client ID does not authorize arbitrary redirect URLs. An
explicit root callback such as `http://127.0.0.1:53110/` is valid; its host,
port and path still match exactly, without wildcard ports.

```powershell
# Import metadata and provide the MCP credential securely on first setup:
./deploy-local.ps1 start -Project YOUR_PROJECT -McpConfig /absolute/private/mcp.json
# Or use the file as defaults for the interactive MCP-only editor:
./deploy-local.ps1 edit-config -Project YOUR_PROJECT -ConfigureMcp -McpConfig /absolute/private/mcp.json
./deploy-local.ps1 start -Project YOUR_PROJECT
./deploy-local.ps1 check -Project YOUR_PROJECT
./deploy-local.ps1 stop -Project YOUR_PROJECT
```

### Why three protected files?

The API wizard also persists credentials behind the scenes. The MCP wizard now
does the same, but OAuth adds two independent internal keys:

| Import field | Purpose | Wizard behavior |
| --- | --- | --- |
| `clientSecretFile` | MCP's confidential Entra credential for its OAuth/OBO exchanges; not the API application's credential | Hidden input, or Enter to keep the saved credential |
| `signingKeyFile` | Signs the MCP OAuth reference tokens issued to downstream clients | Generated once at genuine first setup; retained thereafter |
| `encryptionKeyFile` | Encrypts persisted OAuth credentials/state, including refresh credentials | Generated once at genuine first setup; retained thereafter |

The wizard saves them as `.local/<project>/secrets/mcp-client`, `mcp-signing`
and `mcp-encryption`, with protected directories and0600 files. Never put their
contents into metadata JSON, environment variables, client examples or chat.
On reconfiguration, Enter keeps existing values; missing/corrupt signing or
encryption keys are **not regenerated**. Restore the original state. Existing
OAuth volume/operation receipts also prohibit first-setup key generation even
if metadata was lost. A missing/expired Entra credential can be resupplied with
`-ConfigureMcp` while retaining the original keys and connections.

For noninteractive imports or deliberate key rotation, the metadata file can
add the three optional absolute paths `clientSecretFile`, `signingKeyFile` and
`encryptionKeyFile`. These reference existing regular non-linked protected0600
UTF-8 files of1–8192 bytes, not secret values. Signing material is32 independent
random bytes in canonical URL-safe base64. Encryption is a JSON array of1–3
independent Fernet keys, newest first; retain old keys while their records exist.
All three values must be independent and must not reuse API/session credentials.
Omitted paths retain saved files; keys are generated only for explicit first
setup without existing MCP configuration, operation records or OAuth volume.

Omitted optional MCP configuration keeps MCP absent; omitting `-McpConfig` does
not disable previously saved MCP settings.
`null`, partial and unknown fields are not an instruction to disable it.
To retire an installed MCP service, stop the exact project first, preserve its
protected backup, explicitly remove only its MCP container/settings/state, and
restart API/web through the same owner. Never use orphan removal or prune.

The current image uses Python3.14.6 with an immutable base digest, uv0.12.17
and `mcp/uv.lock` (`uv sync --frozen --no-dev --no-editable` on the approved
Python feed). The non-root production stage contains only the installed
package/dependencies, not tests, source checkout, uv or secret files.
`mcp/Dockerfile` also provides non-root `test` and synthetic-only `fixture`
targets. Test-only OAuth/provider transports never enter production.
All npm builds retain the approved npm feed; Python has no public/extra index
or automatic interpreter-download fallback.

The operator UID/GID is also the container UID/GID, never0; the image's direct
default is10001:10001. The three secret files are mounted read-only, separately.
MCP has no tenant registry, PostgreSQL, session or API credential mount.
`<project>_mcp-oauth` is a dedicated named persistent volume with owned0700
directories and0600 files, distinct from `<project>_data`. The existing owner
labels it for that exact project/purpose and records its immutable creation
identity in `mcp-storage.json`; missing/replaced recorded volumes require restore,
not silent recreation. A one-shot network-free helper, with no secrets mounted,
has only CHOWN/FOWNER to set an **empty root-owned** volume to the operator's
non-root UID/GID and0700. Nonempty foreign-owned state is refused. The service
itself always runs non-root with no capabilities.
The existing strict `os.getuid()`/file-mode checks run inside the actual image
before API drain. Docker Desktop/Windows file mapping must satisfy these same
checks; startup refuses an incompatible mapping rather than relaxing security.
Docker Desktop's exact `/host_mnt/Users/...` inspection spelling is recognized
only against the same expected host path and verified local Desktop socket;
foreign paths, remote daemons and environment-overridden Docker targets fail.

The internal API origin is fixed at `http://app:3001`; it is never the public
MCP identity or a browser callback. MCP publishes only
`127.0.0.1:<port>:8000`. Its separate **HTTPS** identity above requires an
already authorized reverse proxy preserving the exact Host and Origin.
The Entra reply URL is `https://mcp.example.test/auth/callback`, at the origin
root; client redirect URIs are separately exact-allowlisted. Uvicorn ignores
forwarded headers, trusts no proxy-supplied identity and keeps Host/Origin/CSRF
checks enabled. The deployment owner creates no ingress, tunnel, DNS or consent.

MCP is bounded at0.5 CPU,512MiB memory,128 PIDs,32 HTTP connections,64 queued
connections and two5MiB log files. Encrypted state retains the package's4096-file/
64MiB/24-hour bounds. Readiness performs an encrypted write/read/delete, not
an API/provider call. Local health is **not** live OAuth or tool-journey proof.
SIGTERM allows65 seconds for in-flight work (individual invocation limit60s);
Compose allows75 seconds. API/web has no MCP dependency and remains usable
when MCP is stopped. These configured ceilings are not a measured capacity claim.

Normal start builds the exact source snapshot, preflights current/empty SQL,
then starts API/web and configured MCP. It never migrates/reset SQL for MCP.
Immutable MCP image identities and keyed secret/configuration identities are
recorded in `mcp-deployment.json`/`mcp-operation.json`. A failed MCP start can be
retried with ordinary `start`; the API stays available, and the receipt is marked
verified only after exact-image readiness. Atomic secret replacement forces only
MCP recreation even when image bytes are unchanged. Pinned release candidates
must include a source-bound `images.mcp` identity when MCP is configured.

## Prerequisites

- PowerShell 7
- Docker Desktop, or Docker Engine with Compose v2
- Git and a checkout of this repository
- An Entra administrator who can register applications and grant consent

On Windows, use the same `deploy-local.ps1` script with PowerShell 7 and Docker
Desktop configured for Linux containers. The script does not require an elevated
PowerShell session. Protected directories grant the current Windows account
access to their child folders and files; individual secret files remain private
to that account. Retry a failed first start with ordinary `start`, without
`-DbReset` or deleting saved configuration.

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
