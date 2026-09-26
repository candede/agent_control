# Deployment setup

Phase 02 defines the Entra, secret, and local runtime contract. It does not deploy Azure resources, grant API permissions, assign tenant roles, or qualify live providers. Production infrastructure ownership remains in Phase 12.

## Prerequisites

- Docker Desktop with Compose v2.
- PowerShell 7 (`pwsh`).
- An approved Microsoft Entra app registration per configured tenant, each with its tenant ID, client ID, client secret and explicit accepted username domains. Registrations may remain single-tenant.
- For Azure preparation, permission to prepare the registrations and app-role assignments, read the six base Key Vault secrets plus the optional registry secret, and deploy the later Bicep resources.

## Entra application

For **each configured tenant**, an authorized administrator imports only the `appRoles` entries from [the manifest](../infra/entra-app-manifest.json) into that tenant's approved registration, preserving its identity, credentials, reply URLs, API permissions, consent, and other configuration. Each registration can remain single-tenant; do not replace the entire registration. The manifest contains exactly two enabled roles with fresh IDs:

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

All configured registrations use the deployment's **same** callback. Repeat app-role definitions, Enterprise-application assignments, required provider permissions and tenant administrator consent in every tenant. Consent or roles in one tenant do not authorize another.

### Signed-in user's Microsoft roles

Use the dedicated [user roles and permissions guide](user-roles-and-permissions.md) to assign **human** access for each task: agent inventory, block/unblock, Copilot Studio quarantine, user/license sync, Microsoft 365 usage-report downloads, Purview and Defender. It includes least-privilege choices, service-specific roles and PIM activation. This is separate from both the Enterprise application's Viewer/Admin assignment above and the registered-app API permissions below. The task reference is also available in **Permissions > Signed-in user roles**.

### API permissions: administrator prerequisite

Before admitting users, open **Entra admin center > App registrations > the existing Agent Control app > API permissions**. Add permissions for the features being deployed using the exact API and permission type, then select **Grant admin consent** for the tenant. The app has no permission-request or enablement workflow; sign-in does not request additional feature scopes.

Normal sign-in uses only `openid`, `profile`, and `offline_access`; it does not require an additional Graph `User.Read` grant. **Remove `User.Read` if this registration is dedicated to Agent Control.** Keep the three sign-in scopes, which Entra lists under Microsoft Graph.

The same per-permission feature map is available in **Permissions > App prerequisites > Required API permissions**. It lists requirements, not verified tenant grants.

| API | Delegated permission | Exact app feature |
| --- | --- | --- |
| Microsoft Graph / OpenID Connect | `openid` | Sign-in: authenticate the account using an ID token |
| Microsoft Graph / OpenID Connect | `profile` | Sign-in: account identity, display name and username |
| Microsoft Graph / OpenID Connect | `offline_access` | Session renewal: refresh delegated tokens without repeated sign-in |
| Microsoft Graph | `CopilotPackages.Read.All` | Agents / Sync: package inventory and package details |
| Microsoft Graph | `CopilotPackages.ReadWrite.All` | Agents > Manage: availability, installation assignments, block and unblock |
| Microsoft Graph | `User.ReadBasic.All` | Agents > Overview / Manage: resolve people and search users for access assignments |
| Microsoft Graph | `Group.Read.All` | Agents > Overview / Manage: resolve and search access-assignment groups |
| Microsoft Graph | `User.Read.All` | Users / Sync: directory users and their license/service-plan assignments |
| Microsoft Graph | `LicenseAssignment.Read.All` | Users / Sync: tenant product and service-plan catalog |
| Microsoft Graph | `Reports.Read.All` | Users / Sync: refresh 30-day Microsoft 365 Copilot app activity |
| Microsoft Graph | `AgentIdentity.Read.All` | Agents > Activity: verify Studio Entra identities for log matching |
| Microsoft Graph | `AuditLogsQuery.Read.All` | User details > Purview audit: run user-scoped searches; agent details > Activity: search saved records |
| Microsoft Graph | `ThreatHunting.Read.All` | Agents > Activity: Defender / Agent 365 log hunts |
| Power Platform | `ResourceQuery.Resources.Read` | Agents / Sync: refresh Power Platform agent/environment inventory |
| Power Platform | `CopilotStudio.AdminActions.Invoke` | Agents > Manage: check quarantine status, quarantine and restore Studio agents |

**Keep the separately requested read scopes.** Microsoft accepts `CopilotPackages.ReadWrite.All` for [package reads](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list) and `User.Read.All` for [basic directory reads](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0). However, the current app explicitly requests `CopilotPackages.Read.All` for package reads and `User.ReadBasic.All` for directory lookup. Those token requests do not switch to the broader grant. Do not remove these narrower scopes from this version solely because the broader permissions are also configured.

Saved views, local app audit and CSV imports introduce no additional Microsoft API permission requirements. Agent Activity reads saved exact Purview matches; it does not collect live Purview records. OpenID Connect scopes are explained in [Microsoft's sign-in scope reference](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc).

Power Platform's resource/application ID is `8578e004-a5c6-46e7-913e-12f58912df43`. Do not add Graph permissions to that resource. For separately configured shared modes only, grant Microsoft Graph **Application** permissions `CopilotPackages.Read.All`, `AuditLogsQuery.Read.All`, or `ThreatHunting.Read.All` as applicable; a client secret alone does not require application permissions.

Provider roles and licenses remain separate. License discovery requires a supported catalog-reader role such as Directory Readers or Global Reader. Usage reports require a role allowed by that API, such as Reports Reader. Typed agent-identity lookup requires Agent ID Administrator for nonowners. See the [provider contract inventory](provider-contract-inventory-2026-09-08.md) for each feature's exact requirements.

After the administrator changes grants, sign out and back in, then use **Permissions > Check status** or retry the explicit on-demand read. Missing permissions link to administrator setup, not an in-app consent flow. Normal sign-in can still require account selection, MFA or Conditional Access. Admin consent never assigns app roles or bypasses exact-target confirmation for changes.

Register the production canonical HTTPS `/api/auth/callback` Web reply URL only for the approved App Service origin. Prepare explicit `AgentControl.Viewer` or `AgentControl.Admin` assignments; missing or legacy-only assignment is diagnosed, never auto-promoted. Review the [dated provider permission inventory](provider-contract-inventory-2026-09-08.md) before separately approving delegated permissions or application permissions. This phase supplies artifacts only and does not apply registration or grant changes.

## Tenant registry and domain routing

Operators configure profiles; users see a work/school **username form**, not a tenant selector, and there is no in-app tenant management. A profile contains `tenantId` and `clientId` GUIDs, a nonempty single-line `clientSecret`, a nonempty `domains` string array, and optional `displayName` (1–128 printable characters). The registry is a JSON array; this is a structural example only, not working credentials:

```json
[
  {
    "tenantId": "11111111-1111-4111-8111-111111111111",
    "clientId": "22222222-2222-4222-8222-222222222222",
    "clientSecret": "<enter only in the protected registry or Key Vault>",
    "domains": ["contoso.com", "contoso.onmicrosoft.com"],
    "displayName": "Contoso"
  },
  {
    "tenantId": "33333333-3333-4333-8333-333333333333",
    "clientId": "44444444-4444-4444-8444-444444444444",
    "clientSecret": "<enter only in the protected registry or Key Vault>",
    "domains": ["fabrikam.com"]
  }
]
```

The runtime accepts `TENANTS_JSON_FILE` pointing to a protected file, or `TENANTS_JSON` supplied securely (Azure uses a native Key Vault reference). A supplied registry is authoritative: it does not merge with or fall back to legacy settings. Keep credential-bearing JSON out of `settings.json`, `compose.env`, target/ARM parameter files, source, shell arguments, receipts and logs. Local Compose mounts only the generated protected file for identity.

Domains are exact, normalized organization domains, such as `contoso.com`, not email addresses, URLs or wildcards. Unicode-letter IDNs are supported, but separators must be ASCII dots; Unicode dot separators and invisible format controls are rejected before IDNA normalization. A configured parent domain does not implicitly admit its subdomains. Every profile requires at least one domain, even when there is only one tenant. Duplicate tenant IDs and duplicate domains, including case/IDN-equivalent domains, are rejected. The app never discovers tenants from usernames or falls back to an arbitrary/default tenant for an unknown domain.

Without a registry, `TENANT_ID`, `CLIENT_ID` and `CLIENT_SECRET` (or `CLIENT_SECRET_FILE`) define one legacy profile, with required comma-separated `TENANT_DOMAINS` and optional `TENANT_DISPLAY_NAME`. Missing domains require configuration setup, not automatic discovery. `FRONTEND_ORIGIN` and `REDIRECT_URI` remain shared deployment settings, not per-tenant fields.

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

Only the five rows other than `agent-control-postgres-admin-password` are available to the application runtime through native Key Vault references. Multi-tenant mode adds the prepared `agent-control-tenants-json` secret as a sixth runtime reference, `TENANTS_JSON`; its value is the complete registry above. The six base secrets remain required, including the approved primary tenant/application. No application setting, container environment, log, template output, or deployment artifact may contain the administrator password. Do not place provider bearer tokens, MSAL cache content, authorization codes, PKCE verifiers, or browser report data in Key Vault deployment parameters.

Prepare values outside the wizard using the Azure portal's Key Vault Secrets interface or an approved secure administrative tool. Enter secret values directly there, never in chat, command-line arguments, source files, receipts, logs, or ARM outputs. Confirm enabled/not-before/expiry state and value formats without exporting values. The wizard lists missing names and permits an external repair/recheck; it never creates the vault, writes or rotates secrets, or weakens access/network policy.

Enable the vault's access for Azure Resource Manager template deployment. The approved deployment identity needs `Microsoft.KeyVault/vaults/deploy/action`, and the operator runner separately needs narrowly scoped secret metadata/value read for preflight and bootstrap. Bicep must consume the admin password through a native secure Key Vault module parameter, not a plaintext output or command argument. See [Bicep Key Vault parameters](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/key-vault-parameter).

Treat the administrator password as a short-lived bootstrap input even though its approved vault version remains available for future operator recovery. Mount it only into the disposable migration/operator container, remove the container and any generated secure parameter input immediately after bootstrap, and verify it is absent from App Service settings, deployment receipts, package layers and command output. The runtime must receive only the distinct `agentcontrol_app` password.

App Service uses its managed identity with `Key Vault Secrets User` scoped to the five runtime secrets (six with the registry), never the admin-password secret. Preview and approve assignments, or verify administrator-prepared assignments. Check all three access paths independently: ARM template resolution, operator runner data-plane access, and App Service Key Vault references. For a restricted vault, the administrator must prepare the permitted network/DNS path for each caller; an entered vault ID or identity permission alone proves neither reachability nor access. Do not enable broad public access to make validation pass.

Use native versioned app-setting references of this form (names and references only, never resolved values):

```text
@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<secret-name>/<approved-version>)
```

Map `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `SESSION_SECRET`, and `PGPASSWORD` to their five exact table entries. Retain only non-secret version references in release receipts. Select consistent versions for provisioning/bootstrap and runtime references; existing credential changes require the Phase 11 coordinated rotation runbook, not automatic replacement. Structural driver settings use the derived `PGHOST`/`PGPORT`, fixed database `agentcontrol`, and restricted runtime login `agentcontrol_app`. The [Phase 01 database contract](../README.md) owns SQL/bootstrap/grants; `agentcontrol_admin` stays operator-only.

For registry mode, set the approved target's `tenantRegistrySecretName` to `agent-control-tenants-json`, add that name to `preparedVaultContract.secretNames` and `runtimeConsumers`, and select its immutable version in `versions`. Add its current version to `existingVersions` for subsequent deployments; on the first migration from legacy, retain the six unchanged existing versions. The registry must include the approved primary tenant/application, and first migration must preserve its legacy secret. Record `tenantRegistryRegistrationApprovalReference` for administrator verification of the shared callback, roles, assignments and API grants in **every** profile's tenant. Automated directory verification covers the primary registration only; it does not claim cross-directory permission proof. The runtime-reference verifier requires the registry's exact name, vault, version and `Resolved` status.

Legacy Azure targets instead require `tenantDomains` as an explicit nonempty array; `tenantDisplayName` is optional. Named parameters are `-TenantDomains` / `-TenantDisplayName`, or `-TenantRegistrySecretName agent-control-tenants-json` plus `-TenantRegistryRegistrationApprovalReference`. No parameter accepts credential-bearing JSON. See [the Azure runbook](azure-production-deployment.md#tenant-configuration).

## Local workflow

The normal local workflow is Docker-only and preserves the retained Compose project, PostgreSQL volume, secrets, and backend-owned official usage reports. The public interface accepts `start` (default), `stop`, and `edit-config`, positionally or via `-Command` / `-Action`, plus `-Project` (default `agent-control`). Only `start` accepts the explicit destructive `-DbReset` switch (alias `-db-reset`):

```powershell
pwsh ./deploy-local.ps1 start -Project agent-control-phase01
# Omitting start is equivalent:
pwsh ./deploy-local.ps1 -Project agent-control-phase01
```

The canonical local origin is the saved public URL, or `http://localhost:<saved-port>` (default `http://localhost:3001`) when none is set; `127.0.0.1` is only the bind address, not an alternative browser origin. Every `start` invokes the full internal `Deploy` workflow. First it builds the operator and runs backend/frontend tests, backend typecheck, frontend lint and the production build in a uniquely named disposable Compose project. Its `test-db`/`test-postgres` services use synthetic passwords and memory-only data, without application secrets, retained volumes, host ports or external networking. Tests and owned-fixture cleanup must succeed before the runtime build, onboarding, maintenance marker, app shutdown or application database migration. A qualification/build failure leaves the existing app, database and maintenance state untouched. After qualification, deployment starts/checks PostgreSQL and validates its recorded migration history in a read-only transaction. An incompatible or unversioned saved schema fails explicitly before app shutdown or maintenance changes; no checksum is rewritten and no schema is reset. A compatible preflight proceeds to app drain, bootstrap/migration and readiness, with exactly `app` and `postgres` running. It supports fresh databases and compatible retained installations, not an in-place conversion of the retired broad-catalog schema. Separate package/browser/restart checks are documented in [the local runbook](../README.md). Reuse a retained project only when its schema is compatible; do not reset or rotate database/session secrets on rerun. `stop` preserves data and secrets.

For `database_schema_incompatible`, the operator diagnostic names the first mismatching migration version without exposing SQL, credentials or raw driver errors. To deliberately discard the old application database while retaining the same project configuration, run `pwsh ./deploy-local.ps1 start -Project agent-control-phase01 -DbReset`. The flag itself authorizes deletion without another prompt: saved reports, audit, jobs, inventory and sessions are lost. Qualification/build still run first; reset-specific preflight validates the exact target, maintenance connection, operator identity and database ownership without accepting old migration checksums as current. After app drain, only that project's `agentcontrol` database is recreated, then normal bootstrap/migrations/grants run. Settings, secrets, ports, public URL, PostgreSQL roles/volume, other databases and backup files are preserved. Failures after reset starts may leave data deleted and the app in maintenance; fix the failure before retrying. Omit the flag on normal subsequent starts. A separate new project remains an option if the old data must be kept.

The final report shows automated check results and local readiness. Expected error-path logs are quiet unless their Vitest tests fail; failure diagnostics and nonzero exits remain intact.

Runtime configuration uses `FRONTEND_ORIGIN` for same-origin browser checks and `REDIRECT_URI` for the exact `/api/auth/callback` URL on that same origin. Local Compose bounds the `json-file` logs for both persistent services to three 10 MiB files each; rotation is finite local diagnostics, not a second telemetry service. The application completion logger runs before body parsing and admission so denied requests are counted without logging URLs, headers or bodies. Local Compose receives both origin values from the saved public URL or, by default, localhost and the selected port. Azure requires production mode, HTTPS for the single origin, complete tenant credentials with explicit domains through the registry or legacy profile, and a session secret of at least 32 bytes. App Service identity selects the trusted Azure proxy boundary; role or administrator bootstrap environment variables are not supported and cannot assign authority.

Select the saved configuration with `-Project` (default `agent-control`). Project names are 3-40 letters, digits or hyphens, starting with a letter, and are normalized to lowercase, so `pwsh ./deploy-local.ps1 start -Project newCustomer` uses `.local/newcustomer/`. State is fixed beneath the repository root; custom locations are unsupported. First or incomplete `start` launches the wizard for missing tenant ID, client ID, hidden client secret, accepted comma-separated domains and port. The port defaults to `3001` and accepts integers from `1024` through `65535`. Identity/port command-line arguments and a repository `.env` file are not supported. Configured starts reuse all saved profiles and deployment settings without prompting. `stop` and internal maintenance helpers do not prompt for identity.

The helper saves a non-secret `tenants` collection, port and optional public URL in `.local/<lowercase-project>/settings.json`, and the credential-bearing array in `secrets/tenants.json` (Unix mode 0600, directories 0700; owner-only Windows ACLs). On first upgraded `start`, a complete legacy `tenantId`/`clientId` plus `secrets/client-secret` is preserved and only accepted domains are prompted. Port/public URL, database/session secrets, backups and retained data are unchanged. The legacy secret file remains unchanged for recovery but is no longer a runtime input. A migrated registry that is missing, invalid or inconsistent with saved metadata stops for recovery, without falling back to old credentials. Required identity input cannot be blank; malformed GUIDs, domains and ports are retried. Complete onboarding interactively before unattended runs. Never enter secret values in chat or command arguments. The wizard validates input, not live credentials, permissions or consent.

To change saved configuration:

```powershell
pwsh ./deploy-local.ps1 edit-config -Project agent-control-phase01
```

The wizard walks through every profile's tenant ID, client ID, hidden secret, domains and optional display name, then offers **Add another tenant? [y/N]**, followed by the shared port and public URL. Enter preserves values; `-` clears a display name. New profiles must be complete; duplicates are rejected before any save. For a port-only edit, keep all profile fields and decline additions. A previously unconfigured legacy identity may remain incomplete during a port edit, but the next `start` requires credentials and domains. The wizard never displays secrets. No-op edits neither rewrite files nor stop the app. Accepted changes safely drain and stop an existing app; run `start` explicitly afterward. Before changing the canonical origin, register its exact `/api/auth/callback` in every tenant's app.

For dev tunnels, `pwsh ./deploy-local.ps1 -Action edit-config -Project agent-control-phase01` accepts a public URL such as `https://your-tunnel.devtunnels.ms`. It is saved as `publicUrl` in the project settings, separately from the local port; no `:3002` is appended to that public URL. Only a canonical HTTPS origin without a trailing slash, path, query or fragment is accepted. Enter keeps the current value; `local` clears it and restores automatic localhost behavior. The tenant-registry migration preserves an existing public URL without another prompt.

A public URL enables `TRUST_PROXY=1` for one controlled tunnel/reverse-proxy hop, which must forward `X-Forwarded-Proto: https` for secure session cookies. Clearing it disables proxy trust. The listener remains loopback-published, and readiness probes still use localhost: deployment does not verify tunnel availability. Register `https://your-tunnel.devtunnels.ms/api/auth/callback` in Entra and begin a fresh sign-in through the tunnel. Update the setting and registration if the tunnel hostname changes. See the [tunnel walkthrough](../README.md#testing-through-a-dev-tunnel).

The tunnel must also preserve the browser's `Origin` header. Persist this on the existing port with `devtunnel port update YOUR_TUNNEL_ID -p YOUR_LOCAL_PORT --host-header unchanged --origin-header unchanged`, retaining its approved access controls. Then host it with `devtunnel host YOUR_TUNNEL_ID --host-header unchanged --origin-header unchanged`. Host flags alone may not change an existing port's settings. Dev Tunnel's default localhost Origin rewrite causes `403 invalid_origin` on permission checks and sign-out even when sign-in works and the saved public URL is correct. Editing app configuration does not configure the tunnel port. The port update can take effect on a running tunnel. Do not force a fixed trusted Origin or relax the backend check; reload the public URL after updating the port, then retry **Check status** or **Sign out**. An origin rejection's problem response includes `details.expectedOrigin` and `details.receivedOrigin` to distinguish an incorrect app URL from a rewritten or missing browser header.

A tenant ID can be corrected before the project has a database volume; a missing ID can also be filled in. Replacing a saved tenant ID when a volume exists is rejected before stopping the app or writing settings. Add another profile instead. The wizard neither deletes tenant profiles nor migrates data between tenants; a separate project is optional when a fully separate installation is desired.

Adding a tenant or changing a saved client/application ID or domain list on an existing volume writes `control/reauthenticate`. The next `start` clears only persisted login sessions before reopening. It preserves the session-signing secret and all business data. Secret-only, display-name-only or port-only edits do not schedule this purge.

Managed Compose calls clear shell values for project interpolation, `TENANTS_JSON` / `TENANTS_JSON_FILE`, legacy identity/credential/domain settings, origin/callback and proxy trust, then restore them afterward. Exported values cannot override the protected registry, saved project configuration or fixture-only test image.

Testing, retention, backup, isolated restore/reopen and whole-project destruction remain [operator-only helper calls](operations.md#operator-only-local-helpers), not public deployment arguments. The database-only exception is explicit `start -DbReset`.

Runtime secret mounts are only `tenants.json`, `session`, and `postgres-app`; `postgres-admin` remains provisioning/operator-only. Generated DB/session secrets are reused, not silently rotated; missing/corrupt DB/session secrets with an existing volume stop for recovery before onboarding. Keep a matching protected configuration/registry backup separately from database dumps. `start -DbReset` preserves the entire tenant collection, secret files, port/public URL and existing backups; it never recreates profiles. No provider token or MSAL cache file is created.

## Azure workflow

Phase 12 supplies the second supported deployment entry point:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -TargetFile <approved-target.json>
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile <same-approved-target.json>
```

The script accepts an approved target file, equivalent named non-secret parameters, or interactive non-secret prompts. It validates the full existing Key Vault resource ID, six selected base versions plus the optional registry version, explicit legacy domains when not using a registry, exact resource/database identities, dated itemized estimate, budget/change/maintenance approval and explicit Burstable POC risk acceptance. `Plan` performs a real control-plane what-if only in a future explicitly approved Azure session; local tests use `-ExecutionMode Mock` with a fail-closed fixture and are never cloud proof. `Deploy` must use the unchanged approved target after preview. The removed `deploy-production.ps1` and Static Web Apps transport have no wrapper or active release path.

The deployment operator must have:

- Azure Resource Manager deployment access at the target scope;
- `Microsoft.KeyVault/vaults/deploy/action` when secrets are consumed by template deployment;
- data-plane permission to read and validate all six base secrets plus the registry when configured;
- permission to configure the Entra application manifest and its redirect URIs; and
- authority to arrange required runtime managed-identity, Key Vault, and network access without exporting secret values.

The wizard verifies the primary registration and an Admin assignment but never changes directory configuration, consent, API grants, app roles or provider roles. Additional tenants require separate administrator verification recorded by the registry approval reference; the receipt explicitly does not claim their automated directory verification. An authorized administrator applies registration changes separately and reruns preflight. Local mocked validation does not invoke Azure, Entra or a provider.

## Capability enablement

An Agent Control Admin can explicitly enable an optional application-mode capability with approved tenant-shared scope; this does not grant Entra/provider permissions or deploy an adapter. Application mode is opt-in, never delegated fallback. Permissions lists its grants in a collapsed **Optional application permissions** reference rather than a separate access-status tab. Disabled modes and unused features are not issues.

After an assigned Viewer/Admin signs in, the UI loads the catalog and performs one bounded session-scoped delegated check. Opening Permissions displays the saved diagnostics; only **Check status** requests another check. Ordinary catalog, directory and inventory checks may use bounded read adapters; quarantine status, Purview, Defender and implemented Admin-write checks acquire a scoped token only. Current roles, permissions, target confirmation and readback remain enforced independently of the failure-only presentation. These checks never use application mode, import data, start audit/hunting workloads, create refresh jobs or mutate targets.

Transient catalog/check transport failures retry once after one second before appearing. Deterministic denials and throttling do not use that retry. There are no periodic permission checks or expiry-retry cycles. **Check status** remains explicit recovery; authorization decisions and saved data remain protected during retries.

Initial checks defer while hidden, even without an expiry. Later expiry, tab focus and visibility changes only age local diagnostics; they send no permission requests. A previously available delegated token/provider decision remains usable to attempt an operation after its diagnostic timestamp expires. It is not relabeled as fresh provider verification, and actual server/provider denials are reported by the operation. Known denials, invalid evidence, internal roles and application/shared-scope expiry requirements are unchanged.

The Permissions first-page check does not import inventory. Separately, opening Agents starts one initial delegated, read-only refresh per authorized session when no broad saved inventory snapshot exists. This reads provider inventory and saves the observation; it never changes packages or quarantine state. Existing saved inventory remains available without repeating that initial refresh, and explicit refresh remains available when a newer observation is needed.

Implemented package controls and Copilot Studio quarantine changes run on demand with explicit Admin confirmation and no prior canary or additional configuration. Authentication, Admin authorization, same-origin/CSRF checks, real provider tokens and permissions, exact targets, explicit confirmation, audit, live prestate checks and post-write readback remain required. Delegated scope acquisition is checked by safe readiness checks and again when the operation executes; known missing or expired authorization is not bypassed. Readiness permits an attempt; it does not guarantee provider authorization, licensing, operation success or protection against every concurrent external change. Optional canary runs still require their actual approvals and restoration checks, but their absence or results never gate ordinary implemented writes.

Power Platform inventory is delegated-only. An administrator adds Power Platform API application ID `8578e004-a5c6-46e7-913e-12f58912df43`, delegated scope `ResourceQuery.Resources.Read`, and grants admin consent outside the app. Normal sign-in does not request feature consent. Assign `AgentControl.Viewer` or `AgentControl.Admin` plus one documented Entra role: Global Administrator, Power Platform Administrator, Dynamics 365 Administrator or Global Reader for full inventory, or AI Administrator/AI Reader for AI-scoped coverage. Built-in Power Platform RBAC is not a substitute. Conditional Access must permit the documented Resource Query path, including any Azure Resource Manager dependency reported by the provider.

Copilot Studio quarantine uses the same Power Platform application audience but a separate delegated consent group and exact scope, `CopilotStudio.AdminActions.Invoke`. Viewer may observe authorized exact status; changes require `AgentControl.Admin`, provider-issued delegated authorization, approved consent, and explicit confirmation of the exact environment/agent target. Live prestate and post-write readback remain part of the operation; a canary receipt is not a prerequisite. Agent Control does not reconstruct quarantine eligibility from optional `wids` claims or hard-deny solely because such a claim is absent; the provider remains authoritative and may deny the request. Application credentials do not authorize this delegated workflow. Do not fabricate capability evidence or edit database rows to claim authorization or success.

The delivered adapter targets global `api.powerplatform.com` only. Sovereign-cloud tenants must remain unsupported until a separately documented endpoint, audience and schema contract is implemented and qualified. Classic/V1 bots are excluded by the current inventory API; unpublished configuration, hidden workflow environments and preview connector/capability fields can remain absent. After consent and role assignment, the session performs its bounded automatic checks; use Data sync or the explicit Power Platform source refresh in Sync diagnostics when a new saved inventory observation is needed. Automatic quarantine read and Admin management checks acquire a token but do not call an exact target or prove provider operation/license access.

### Verified Power Platform inventory

A successful sync and a verified saved inventory are distinct measurable results. Sync completes only after validated provider enumeration and atomic publication. Saved inventory checks run automatically whenever saved inventory is loaded; no manual verification or administrator approval is required after sync. The optional **Verify saved inventory** action in **Sync > Advanced results** repeats those saved reads, checking actual stored rows and normalized identities against provider totals and captured request scope, and verifying that each collected source target appears exactly once in the unified view. The receipt covers the entire unfiltered inventory, not just the visible page. It also reports pending/invalid matching metadata and ambiguous/conflicting identities.

For optional troubleshooting, open **Sync > Advanced results** (collapsed by default):

1. Confirm the relevant sync run and its source jobs succeeded. Power Platform resource totals include queried agents and supporting environments, not just agents.
2. Inspect the automatic receipt, or use **Verify saved inventory** to repeat the saved checks. Check the stored/provider resource counts, page count, unique source memberships, and matching checks. A source accounting or saved-row mismatch fails explicitly; refresh the affected source rather than manually editing counts or role IDs.
3. Review the actual queried types and environment scope. An environment-filtered snapshot remains limited; unqueried or role-filtered types are not presented as verified zeros. The absence of an environment filter means all environments were requested for the authenticated API query.
4. Review source observation times separately from the verification time. Rechecking saved data is not a live provider refresh. Refresh the source when newer Microsoft data is needed; another clean resync is not necessary merely to verify an existing complete snapshot.

Optional Entra `wids` claims are diagnostic hints, not collection proof. Missing claims neither establish denial nor turn a verified query into partial completion. `AgentControl.Admin` is not an Entra role or a provider permission grant, and actual provider authorization remains required for every live operation. Administrators may configure directory-role claims for diagnostics, but the app does not require broader directory consent or role assignments to clear a misleading status label. All supported request plans now include only agents and supporting environments. Actual executed types are persisted independently of role hints so later claim/policy changes cannot relabel an unqueried type as covered.

Inventory retries and snapshot replacement use the requested resource types and environment, not optional role hints. A changed or missing hint does not conflict with an otherwise identical idempotent retry or let older work supersede a newer running or successful refresh. Retained jobs and snapshots are matched by their saved request scope without rewriting their old hashes. An expired idempotent job returns `inventory_job_expired`; submit a new refresh with a new idempotency key.

Microsoft's inventory excludes classic/V1 bots and can lag changes, typically by about 20 minutes. Verification is scoped to the saved authorized queries, not a claim that every possible agent surface is represented. Source-only records can legitimately remain unlinked without shared identity evidence.

**Sync complete** tracks source collection, not cross-provider identity matching. Current default runs collect the three automatic sources; retained runs that include report imports keep their original four-source scope. Power Platform refresh progress counts requested agents and supporting environments, not just agents. A fully checked Graph package can still lack source-declared identity metadata, and unlinked Graph/Power Platform rows can legitimately represent different provider surfaces. Do not merge them by name or treat their counts as missing-agent counts.

The canonical Agents inventory uses different typed identity rules for different agent kinds. Agent Builder/declarative packages can lack `AgentMetadatas` entirely: their package `manifestId` is associated only with a unique authorized agent whose native ID **and** GUID `schemaName` both agree. Studio packages use explicit environment/CDS/schema or typed source identities. A package's `AgentIdentityId` is not interchangeable with every Power Platform Entra identifier; differences do not veto corroborated native identity. Custom-engine wrappers can share a native association through matching `Bots.botId` and `CustomEngineCopilots` bot IDs when another current package uniquely establishes that native association. Shared bot applications with competing native/environment claims remain ambiguous. These are source-metadata associations, not permission or quarantine-target grants.

Initialize a fresh database through schema version 38 before starting this agent-centered runtime. The narrowed definitions change the Power Platform portions of versions 5 and 33 directly; existing broad-catalog databases are not an in-place upgrade target. Version 32 remains unchanged. Migration 33 replaces stored role-derived coverage with actual queried types while preserving source resources, provider totals, roles, timestamps, and canonical identities. Migration 37 deletes the app's Users-sync cache once and requires a fresh Users sync for M365 Copilot entitlement evidence and paid-feature states; it leaves agent inventory and imported reports intact. Migration 38 permits both verified stages of a same-action package access canary without changing block/unblock uniqueness or runtime grants. The effective-entitlement correction and larger directory-page budget require no additional migration, cache reset or permissions. Users sync counts the complete filtered directory candidate roster, not effectively licensed users, all tenant accounts or basic Copilot Chat users. Licensed labels and paid-adoption metrics use verified active paid features, never containing product assignment alone; current service-format snapshots already provide that evidence. Canonical entities and source memberships are private to the tenant/account, foreign-keyed to their authorized observations, and reconciled under the source-publication locks. Publication advances existing memberships to the selected replacement observations and clears old matching proof, preserving unchanged canonical IDs even if retention runs before another Agents read. Withdrawn or contradictory proof can split an association rather than preserve a stale merge. Confirmed clean resync clears the requesting account's canonical records as well as source snapshots. Do not manually relabel manifest IDs or bot application IDs as `cds_bot_id`.

### Power Platform agent source

Power Platform is an agent source, not a standalone page. Both Data sync and explicit source refresh collect only `microsoft.copilotstudio/agents` and `microsoft.powerplatform/environments`. Agents owns saved agent search, filtering, exports, native configuration, activity and separately authorized exact quarantine/restore controls. Environment rows support agent context; embedded agent connector operations and environment group/managed properties remain available without collecting separate apps, flows, connectors or environment groups. Missing, unqueried, or role-filtered data is not counted as zero. The retired catalog URL has no redirect or bookmark migration, and its generic list/snapshot APIs have been removed.

**Refresh Power Platform agents** in Sync diagnostics reads agents and supporting environments and saves a snapshot only after complete enumeration. A failed first refresh therefore leaves no saved inventory; a later failed refresh preserves the previous snapshot. Page/resource counts on a failed job describe partial progress, not a usable complete snapshot. An HTTP 200 when reading a job does not mean that the refresh succeeded.

Sync history and **Inspect source job** open `/sync?powerPlatformJob=<id>` for the exact source job, rather than substituting the latest attempt. The inspector shows status, original scope, provider totals (including unknown), observed counts, pages, omitted fields and errors. Waiting source work can be resumed or cancelled, running work can be cancelled, and failed/cancelled source work can be replaced through an explicit new refresh with the original scope. Opening diagnostics makes no provider call. Successful publication reloads saved agent data; stale targets and snapshots cannot authorize controls. Normal sync runs are restarted through the standard Sync action, not retried from history.

This narrowed schema requires fresh initialization. There is no compatibility migration or rescue of obsolete catalog rows; do not apply the current runtime to an old broad-catalog database and assume its old schema has been converted.

Refreshes retain 100-resource pages, a 50-page/5,000-row bound and a ten-second limit per page request, including response-body consumption. Complete enumeration has a 120-second budget; the enclosing refresh allows 150 seconds for enumeration plus authorization and publication. This accommodates large inventories requiring more than 30 seconds without increasing response sizes or publishing partial data. Exhausting either budget produces an explicit timeout failure, not a request for additional consent.

Paging uses a fixed native-identity order and the returned `SkipToken`. Continuation requests must omit `Skip`: the API uses [Resource Graph query options](https://learn.microsoft.com/en-us/power-platform/admin/inventory-api#query-options), where [an explicit Skip overrides the token's offset](https://learn.microsoft.com/en-us/dotnet/api/azure.resourcemanager.resourcegraph.models.resourcequeryrequestoptions.skip). Sending `Skip: 0` again can repeat the first page and trigger the duplicate-identity guard; do not suppress that guard or publish partial results.

The provider can leave `resultTruncated` set on the final page without a continuation token. That terminal page is accepted only when the accumulated, validated, unique resources exactly equal the unchanged `totalRecords` (for example, 41 pages of 100 plus a final page of 40 for a total of 4,140). A missing token before that total, a token after that total, duplicate identities, changed totals, malformed rows and out-of-scope data still fail without publishing an incomplete snapshot.

Every collected agent/environment row must identify the authenticated query tenant. Missing or foreign tenant IDs, retired resource types, duplicates and out-of-scope responses fail publication. The former connector-catalog tenant fallback is removed. Native resource IDs are never truncated or replaced.