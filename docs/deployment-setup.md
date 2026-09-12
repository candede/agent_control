# Deployment setup

Phase 02 defines the Entra, secret, and local runtime contract. It does not deploy Azure resources, grant API permissions, assign tenant roles, or qualify live providers. Production infrastructure ownership remains in Phase 12.

## Prerequisites

- Docker Desktop with Compose v2.
- PowerShell 7 (`pwsh`).
- A Microsoft Entra single-tenant app registration, with its tenant ID, client ID and client secret for local onboarding.
- For Azure preparation, permission to edit the app registration, assign its app roles, read the six required Key Vault secrets, and deploy the later Bicep resources.

## Entra application

An authorized administrator imports only the `appRoles` entries from [the manifest](../infra/entra-app-manifest.json) into the approved single-tenant registration, preserving its existing identity, credentials, reply URLs, API permissions, consent, and other configuration. Do not replace the entire registration. The manifest contains exactly two enabled roles with fresh IDs:

| Role | Manifest role ID |
| --- | --- |
| `AgentControl.Viewer` | `8a02b7f3-bdbf-4193-8b29-4da05684fb5a` |
| `AgentControl.Admin` | `9feab889-b807-4a97-a504-944ab53a380b` |

`AgentControl.Admin` includes all Viewer access, so assigning Viewer or Admin is sufficient and assigning both is unnecessary. In **App registrations > App roles**, **Allowed member types: Users/Groups** corresponds to `"allowedMemberTypes": ["User"]`; it permits human users and groups, not workload identities. The separate `"origin": "Application"` property means the role is defined on the app registration. It does not mean the assignee is an application and does not enable app-only provider access.

If the roles are created manually in the portal rather than imported, Entra generates different fresh role IDs. That is supported: read and use the Enterprise application's actual Viewer/Admin role IDs for assignments and verification. Never substitute a manifest ID for the actual registered role ID, and never reuse a legacy role ID. The role values, enabled state, Users/Groups member type, hierarchy, and exactly-two-role contract remain identical.

In **Enterprise applications > your app > Properties**, set **Assignment required?** to **Yes**. Assign Viewer for observation/read workflows or Admin when supported changes and configuration are required. One assignment is sufficient and recommended. A group may supply the assignment to its approved direct members, subject to Entra licensing and group-assignment rules. Overlapping direct and group assignments do not need a workaround or cleanup merely because both current values are effective: the application accepts both and applies the Admin superset. Verify that every approved user has at least one intended current assignment. Unassigned users receive no protected data.

### Safe migration from legacy roles

The former `AgentControl.Reader`, `AgentControl.Operator`, `AgentControl.SecurityReader`, and `AgentControl.Administrator` assignments are migration inputs only; they are not current authorization aliases.

1. Preserve all non-role registration configuration. Add the two roles with the manifest IDs above, or with fresh Entra-generated IDs when creating them manually; never reuse a legacy role ID.
2. Explicitly choose and assign Viewer or Admin to each approved user or approved group; one role is sufficient and recommended. Never silently promote a former Reader or SecurityReader assignment to Admin. Use the person's approved duties, not the old role name, to decide.
3. Validate Viewer and Admin behavior, effective membership, callback/sign-in, tenant/source isolation, and capability-specific provider prerequisites.
4. Remove old Enterprise-application assignments. Then disable and, when Entra permits, delete the legacy app-role definitions using the required Entra app-role removal process. Never delete an enabled or still-assigned role.
5. Require a fresh login after assignment changes. For the deployment/session cutoff, restart or run the approved session-invalidation procedure so cached legacy claims cannot survive.
6. Reapprove any optional role-bound canary plans whose approver/executor role evidence changed. Do not edit retained evidence to make it current; canary evidence does not gate ordinary implemented writes.

Sign out and back in after any assignment change. App roles do not bypass provider consent, service roles, service access, licensing, exact-target validation, confirmation or audit requirements.

The manifest intentionally contains no `requiredResourceAccess` entries. Configure the web redirect URI for local authentication as:

```text
http://localhost:3001/api/auth/callback
```

Assign Viewer or Admin to each approved principal; one current assignment is sufficient and recommended because Admin includes Viewer. Normal sign-in requests outstanding consent for all implemented delegated capabilities up front: Graph package catalog and changes (`CopilotPackages.ReadWrite.All`), directory, Purview and Defender, plus Power Platform inventory and quarantine. MSAL `extraScopesToConsent` includes the additional resource scopes only in authorization; token requests remain resource-specific. Already approved permissions normally need no repeated consent screen. Tenant-wide admin consent for the intended delegated scopes is recommended before admitting ordinary users. Application permissions remain separate and are not requested by login.

**Sign in without provider setup** explicitly defers these requests and opens Permissions after identity-only login. Use it when a tenant administrator must approve consent or when only authorized saved/local data is needed. Cancelling setup never starts an automatic redirect loop. Package and quarantine changes still require the internal Admin role and explicit confirmation; no consent choice assigns Microsoft roles, licenses, or Agent Control app roles. The **Setup instructions** button opens local help; **Request consent** or **Continue sign-in / consent** initiates Microsoft authorization only after a check identifies missing permission or required interaction. Existing installations should use normal sign-in again after redeployment to request newly included permissions.

Register the production canonical HTTPS `/api/auth/callback` Web reply URL only for the approved App Service origin. Prepare explicit `AgentControl.Viewer` or `AgentControl.Admin` assignments; missing or legacy-only assignment is diagnosed, never auto-promoted. Review the [dated provider permission inventory](provider-contract-inventory-2026-09-08.md) before separately approving delegated permissions or application permissions. This phase supplies artifacts only and does not apply registration or grant changes.

## Required Key Vault secrets

The production workflow accepts a full Azure resource ID for an existing vault:

```text
/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.KeyVault/vaults/<vault-name>
```

Use an existing RBAC-enabled vault in the approved tenant/subscription. These are secret **names**, not Azure resource tags or secret attributes. Other existing vault contents remain untouched. The six required deployment inputs are:

| Secret | Purpose | Runtime exposure |
| --- | --- | --- |
| `agent-control-tenant-id` | Tenant GUID matching the approved tenant | Tenant validation and runtime `TENANT_ID` |
| `agent-control-client-id` | Existing Entra application/client GUID | Application validation and runtime `CLIENT_ID` |
| `agent-control-client-secret` | Valid secret for that Entra application | Runtime `CLIENT_SECRET` |
| `agent-control-session-secret` | Independent high-entropy value of at least 32 random bytes encoded as text | Runtime `SESSION_SECRET` |
| `agent-control-postgres-admin-password` | Strong PostgreSQL-compatible password for `agentcontrol_admin` | Provisioning and operator migration/maintenance only |
| `agent-control-postgres-app-password` | Different strong password for restricted login `agentcontrol_app` | Bootstrap and runtime `PGPASSWORD` |

All six secrets must exist, be enabled, have non-empty values in the formats above, and be unexpired. When expiry metadata is present it must be in the future. The two database passwords must differ. The deployment operator needs narrowly scoped secret-value and metadata read access for validation. The later Azure deployment identity also needs `Microsoft.KeyVault/vaults/deploy/action` when Bicep resolves Key Vault references.

Only the five rows other than `agent-control-postgres-admin-password` are available to the application runtime through native Key Vault references. No application setting, container environment, log, template output, or deployment artifact may contain the administrator password. Do not place provider bearer tokens, MSAL cache content, authorization codes, PKCE verifiers, or browser report data in Key Vault deployment parameters.

Prepare values outside the wizard using the Azure portal's Key Vault Secrets interface or an approved secure administrative tool. Enter secret values directly there, never in chat, command-line arguments, source files, receipts, logs, or ARM outputs. Confirm enabled/not-before/expiry state and value formats without exporting values. The wizard lists missing names and permits an external repair/recheck; it never creates the vault, writes or rotates secrets, or weakens access/network policy.

Enable the vault's access for Azure Resource Manager template deployment. The approved deployment identity needs `Microsoft.KeyVault/vaults/deploy/action`, and the operator runner separately needs narrowly scoped secret metadata/value read for preflight and bootstrap. Bicep must consume the admin password through a native secure Key Vault module parameter, not a plaintext output or command argument. See [Bicep Key Vault parameters](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/key-vault-parameter).

Treat the administrator password as a short-lived bootstrap input even though its approved vault version remains available for future operator recovery. Mount it only into the disposable migration/operator container, remove the container and any generated secure parameter input immediately after bootstrap, and verify it is absent from App Service settings, deployment receipts, package layers and command output. The runtime must receive only the distinct `agentcontrol_app` password.

App Service uses its managed identity with `Key Vault Secrets User` scoped to the five runtime secrets, never the admin-password secret. Preview and approve assignments, or verify administrator-prepared assignments. Check all three access paths independently: ARM template resolution, operator runner data-plane access, and App Service Key Vault references. For a restricted vault, the administrator must prepare the permitted network/DNS path for each caller; an entered vault ID or identity permission alone proves neither reachability nor access. Do not enable broad public access to make validation pass.

Use native versioned app-setting references of this form (names and references only, never resolved values):

```text
@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<secret-name>/<approved-version>)
```

Map `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `SESSION_SECRET`, and `PGPASSWORD` to their five exact table entries. Retain only non-secret version references in release receipts. Select consistent versions for provisioning/bootstrap and runtime references; existing credential changes require the Phase 11 coordinated rotation runbook, not automatic replacement. Structural driver settings use the derived `PGHOST`/`PGPORT`, fixed database `agentcontrol`, and restricted runtime login `agentcontrol_app`. The [Phase 01 database contract](../README.md) owns SQL/bootstrap/grants; `agentcontrol_admin` stays operator-only.

## Local workflow

The local workflow is Docker-only and preserves the retained Compose project, PostgreSQL volume, secrets, and backend-owned official usage reports. The public interface accepts `start` (default), `stop`, and `edit-config`, positionally or via `-Command` / `-Action`, plus `-Project` (default `agent-control`):

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control-phase01
# Omitting start is equivalent:
pwsh ./deploy-local.ps1 -Project agent-control-phase01
```

The canonical local origin is the saved public URL, or `http://localhost:<saved-port>` (default `http://localhost:3001`) when none is set; `127.0.0.1` is only the bind address, not an alternative browser origin. Every `start` invokes the full existing internal `Deploy` workflow: it builds operator/runtime images, bootstraps/migrates additively in disposable containers, runs the aggregate baseline, starts exactly `app` and `postgres`, and waits for readiness. It supports both new and retained installations. Separate package/browser/restart checks are documented in [the local runbook](../README.md). Keep using the retained `agent-control-phase01` project name and volume; do not reset or rotate database/session secrets on rerun. `stop` preserves data and secrets.

Runtime configuration uses `FRONTEND_ORIGIN` for same-origin browser checks and `REDIRECT_URI` for the exact `/api/auth/callback` URL on that same origin. Local Compose bounds the `json-file` logs for both persistent services to three 10 MiB files each; rotation is finite local diagnostics, not a second telemetry service. The application completion logger runs before body parsing and admission so denied requests are counted without logging URLs, headers or bodies. Local Compose receives both origin values from the saved public URL or, by default, localhost and the selected port. Azure requires production mode, HTTPS for the single origin, complete `TENANT_ID`/`CLIENT_ID`/`CLIENT_SECRET` configuration, and a session secret of at least 32 bytes. App Service identity selects the trusted Azure proxy boundary; role or administrator bootstrap environment variables are not supported and cannot assign authority.

Select the saved configuration with `-Project` (default `agent-control`). Project names are 3-40 letters, digits or hyphens, starting with a letter, and are normalized to lowercase, so `pwsh ./deploy-local.ps1 start -Project newCustomer` uses `.local/newcustomer/`. State is fixed beneath the repository root; custom locations are unsupported. First or incomplete `start` launches the wizard for missing tenant ID, client ID, client secret and port. Enter GUIDs and the secret value directly in the terminal; secret input is hidden. The port defaults to `3001` and accepts integers from `1024` through `65535`. Identity/port command-line arguments and a repository `.env` file are not supported. Configured starts reuse all saved values, including the port, without prompting. `stop` and internal maintenance helpers do not prompt for identity.

The helper saves IDs and port in `.local/<lowercase-project>/settings.json` and the secret in `.local/<lowercase-project>/secrets/client-secret` with owner-only permissions (Unix mode 0600); directories are restricted. An absent, empty or whitespace-only client-secret file triggers a new secure prompt on `start`. Required identity input cannot be blank; Enter accepts the default port when none is saved. Malformed GUIDs and invalid ports are prompted again. Complete onboarding in an interactive terminal before unattended runs. Never enter secret values in chat or command arguments. The wizard validates input only: it does not verify live credentials, change app registrations or grant permissions.

To change saved configuration:

```powershell
pwsh ./deploy-local.ps1 edit-config -Project agent-control-phase01
```

The wizard prompts for tenant ID, client ID, hidden client secret, port and public URL, with Enter preserving each current value, even if an identity field is currently unset. For a port-only edit, press Enter at the three identity prompts, enter the port, then press Enter at the public URL prompt. Missing identity values remain required on the next `start`, not during `edit-config`. The wizard never displays the current secret. Unchanged settings are not rewritten and leave a running app untouched. Accepted changes to the client ID, client secret, port or public URL stop the app safely and leave it stopped; run `start` explicitly afterward. Before starting with a changed canonical origin, register its exact `/api/auth/callback` as an Entra Web reply URL.

For dev tunnels, `pwsh ./deploy-local.ps1 -Action edit-config -Project agent-control-phase01` accepts a public URL such as `https://your-tunnel.devtunnels.ms`. It is saved as `publicUrl` in the project settings, separately from the local port; no `:3002` is appended to that public URL. Only a canonical HTTPS origin without a trailing slash, path, query or fragment is accepted. Enter keeps the current value; `local` clears it and restores automatic localhost behavior. Existing projects need no migration or additional prompt on `start`.

A public URL enables `TRUST_PROXY=1` for one controlled tunnel/reverse-proxy hop, which must forward `X-Forwarded-Proto: https` for secure session cookies. Clearing it disables proxy trust. The listener remains loopback-published, and readiness probes still use localhost: deployment does not verify tunnel availability. Register `https://your-tunnel.devtunnels.ms/api/auth/callback` in Entra and begin a fresh sign-in through the tunnel. Update the setting and registration if the tunnel hostname changes. See the [tunnel walkthrough](../README.md#testing-through-a-dev-tunnel).

The tunnel must also preserve the browser's `Origin` header. Persist this on the existing port with `devtunnel port update YOUR_TUNNEL_ID -p YOUR_LOCAL_PORT --host-header unchanged --origin-header unchanged`, retaining its approved access controls. Then host it with `devtunnel host YOUR_TUNNEL_ID --host-header unchanged --origin-header unchanged`. Host flags alone may not change an existing port's settings. Dev Tunnel's default localhost Origin rewrite causes `403 invalid_origin` on permission checks and sign-out even when sign-in works and the saved public URL is correct. Editing app configuration does not configure the tunnel port. The port update can take effect on a running tunnel. Do not force a fixed trusted Origin or relax the backend check; reload the public URL after updating the port, then retry **Check status** or **Sign out**. An origin rejection's problem response includes `details.expectedOrigin` and `details.receivedOrigin` to distinguish an incorrect app URL from a rewritten or missing browser header.

The tenant ID can change before the project has a database volume; a previously missing tenant ID can also be filled in. Changing a nonempty saved tenant ID when a volume exists is rejected before stopping the app or writing settings. Configuration edits do not migrate data between tenants; use a separate project for another tenant.

Changing the saved client/application ID on an existing volume stops the app and writes `control/reauthenticate` in the project state directory. The next `start` clears only persisted login sessions before reopening, requiring sign-in under the new app registration. It preserves the session-signing secret and all business data. Secret-only or port-only edits do not schedule this purge.

Managed Compose calls clear shell values for `LOCAL_STATE_DIR`, `APP_PORT`, `APP_UID`, `APP_GID`, `APP_IMAGE`, `TENANT_ID`, `CLIENT_ID`, `FRONTEND_ORIGIN`, `REDIRECT_URI`, and `TRUST_PROXY`, then restore them afterward. Those exported variables cannot override saved project configuration.

Testing, retention, backup, isolated restore/reopen and destructive reset remain [operator-only helper calls](operations.md#operator-only-local-helpers), not public deployment arguments.

Runtime mounts only `client-secret`, `session`, and `postgres-app`. The operator alone mounts `postgres-admin`. Existing identity values are preserved; use a separate project for another tenant. Generated DB/session secrets are reused, not silently rotated; missing/corrupt DB/session secrets with an existing volume stop for recovery before onboarding. No provider token or MSAL cache file is created.

## Azure workflow

Phase 12 supplies the second supported deployment entry point:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -TargetFile <approved-target.json>
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile <same-approved-target.json>
```

The script accepts an approved target file, equivalent named non-secret parameters, or interactive non-secret prompts. It validates the full existing Key Vault resource ID, six selected versions, exact resource/database identities, dated itemized estimate, budget/change/maintenance approval and explicit Burstable POC risk acceptance. `Plan` performs a real control-plane what-if only in a future explicitly approved Azure session; local tests use `-ExecutionMode Mock` with a fail-closed fixture and are never cloud proof. `Deploy` must use the unchanged approved target after preview. The removed `deploy-production.ps1` and Static Web Apps transport have no wrapper or active release path.

The deployment operator must have:

- Azure Resource Manager deployment access at the target scope;
- `Microsoft.KeyVault/vaults/deploy/action` when secrets are consumed by template deployment;
- data-plane permission to read and validate all six required secret values and metadata;
- permission to configure the Entra application manifest and its redirect URIs; and
- authority to arrange required runtime managed-identity, Key Vault, and network access without exporting secret values.

The wizard verifies registration differences and an Admin assignment but never changes directory configuration, consent, API grants, app roles or provider roles. An authorized administrator applies any approved registration change separately and reruns preflight. The local-only Phase 12 implementation did not invoke Azure, Entra or a provider.

## Capability enablement

An Agent Control Admin can explicitly enable an optional application-mode capability with approved tenant-shared scope; this does not grant Entra/provider permissions or deploy its adapter. Application mode is gated opt-in, with no automatic delegated-to-application fallback. Delegated-only deployments keep it disabled, and intentionally disabled optional modes are excluded from primary health rather than counted as degraded. After an assigned Viewer/Admin session appears or returns from consent, the UI loads the capability catalog and immediately performs one bounded session-scoped delegated check. It refreshes on active evidence expiry only while visible and waits for visibility/focus when hidden. Ordinary catalog, directory and inventory checks may use their bounded read adapter; authorized quarantine read, Purview, Defender and implemented Admin write capabilities acquire a scoped token only. An Admin action with no prior evidence initially reports `verification: on_demand`; the safe check replaces it with expiring token evidence or an actionable failure. Token acquisition does not qualify the provider operation. Quarantine manage readiness never selects a target, calls status/mutation, executes/resumes/reconciles a job, runs a canary, or qualifies a write; Viewer remains denied by the internal-role gate. These checks never use application/shared mode, import, start Audit Search/Defender workloads, create refresh jobs or collect raw data. An expiry or transport failure receives exactly one delayed automatic retry after 30 seconds; no further automatic retry occurs for that evidence signature. **Check status** remains optional explicit recovery.

The Permissions first-page check does not import inventory. Separately, opening Agents starts one initial delegated, read-only refresh per authorized session when no broad saved inventory snapshot exists. This reads provider inventory and saves the observation; it never changes packages or quarantine state. Existing saved inventory remains available without repeating that initial refresh, and explicit refresh remains available when a newer observation is needed.

Implemented package controls and Copilot Studio quarantine changes run on demand with explicit Admin confirmation and no prior canary or additional configuration. Authentication, Admin authorization, same-origin/CSRF checks, real provider tokens and permissions, exact targets, explicit confirmation, audit, live prestate checks and post-write readback remain required. Delegated scope acquisition is checked by safe readiness checks and again when the operation executes; known missing or expired authorization is not bypassed. Readiness permits an attempt; it does not guarantee provider authorization, licensing, operation success or protection against every concurrent external change. Optional canary runs still require their actual approvals and restoration checks, but their absence or results never gate ordinary implemented writes.

Power Platform inventory is delegated-only. An authorized administrator permits consent for Power Platform API application ID `8578e004-a5c6-46e7-913e-12f58912df43`, delegated scope `ResourceQuery.Resources.Read`; normal sign-in includes this consent request, but no grant is applied by repository scripts. Assign `AgentControl.Viewer` or `AgentControl.Admin` plus one documented Entra role: Global Administrator, Power Platform Administrator, Dynamics 365 Administrator or Global Reader for full inventory, or AI Administrator/AI Reader for AI-scoped coverage. Built-in Power Platform RBAC is not a substitute. Conditional Access must permit the documented Resource Query path, including any Azure Resource Manager dependency reported by the provider.

Copilot Studio quarantine uses the same Power Platform application audience but a separate delegated consent group and exact scope, `CopilotStudio.AdminActions.Invoke`. Viewer may observe authorized exact status; changes require `AgentControl.Admin`, provider-issued delegated authorization, approved consent, and explicit confirmation of the exact environment/agent target. Live prestate and post-write readback remain part of the operation; a canary receipt is not a prerequisite. Agent Control does not reconstruct quarantine eligibility from optional `wids` claims or hard-deny solely because such a claim is absent; the provider remains authoritative and may deny the request. Application credentials do not authorize this delegated workflow. Do not fabricate capability evidence or edit database rows to claim authorization or success.

The delivered adapter targets global `api.powerplatform.com` only. Sovereign-cloud tenants must remain unsupported until a separately documented endpoint, audience and schema contract is implemented and qualified. Classic/V1 bots are excluded by the current inventory API; unpublished configuration, hidden workflow environments and preview connector/capability fields can remain absent. After consent and role assignment, the session performs its bounded automatic checks; use Inventory Explorer's explicit refresh when a new saved inventory observation is needed. Automatic quarantine read and Admin management checks acquire a token but do not call an exact target or prove provider operation/license access.