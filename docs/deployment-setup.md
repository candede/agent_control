# Deployment setup

Phase 02 defines the Entra, secret, and local runtime contract. It does not deploy Azure resources, grant API permissions, assign tenant roles, or qualify live providers. Production infrastructure ownership remains in Phase 12.

## Prerequisites

- Docker Desktop with Compose v2.
- PowerShell 7 (`pwsh`).
- A Microsoft Entra single-tenant app registration when interactive sign-in is being exercised.
- For Azure preparation, permission to edit the app registration, assign its app roles, read the six required Key Vault secrets, and deploy the later Bicep resources.

## Entra application

An authorized administrator imports the `appRoles` entries from [the manifest](../infra/entra-app-manifest.json) into the approved single-tenant registration, preserving its existing identity, credentials, and registered reply URLs. Do not replace the entire registration or overwrite existing API grants. The manifest contains exactly four enabled roles assignable to users or groups:

- `AgentControl.Reader`
- `AgentControl.Operator`
- `AgentControl.SecurityReader`
- `AgentControl.Administrator`

The manifest intentionally contains no `requiredResourceAccess` entries. Configure the web redirect URI for local authentication as:

```text
http://localhost:3001/api/auth/callback
```

Assign only the independent app roles each principal needs. Administrator does not include the other three roles. Provider permission grants and provider-side administrator roles are capability-specific and must not be bundled into initial login.

Register the production canonical HTTPS `/api/auth/callback` Web reply URL only for the approved App Service origin. Prepare an explicit `AgentControl.Administrator` assignment; missing assignment is diagnosed, never auto-promoted. Review the [dated provider permission inventory](provider-contract-inventory-2026-09-08.md) before separately approving delegated permissions or application permissions. This phase supplies artifacts only and does not apply registration or grant changes.

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

The local workflow is Docker-only and preserves the retained Compose project, PostgreSQL volume, secrets, and backend-owned official usage reports:

```powershell
pwsh ./deploy-local.ps1 -Project agent-control-phase01
```

The canonical local origin is `http://localhost:3001`; `127.0.0.1` is only the bind address, not an alternative browser origin. A successful Deploy builds the image, bootstraps/migrates additively in disposable containers, runs the aggregate baseline, starts exactly `app` and `postgres`, and waits for readiness. Separate package/browser/restart checks are documented in [the local runbook](../README.md). Keep using the retained `agent-control-phase01` project name and volume; do not reset or rotate secrets on rerun. `-WhatIf` is not a supported parameter.

Runtime configuration uses `FRONTEND_ORIGIN` for same-origin browser checks and `REDIRECT_URI` for the exact `/api/auth/callback` URL on that same origin. Local Compose bounds the `json-file` logs for both persistent services to three 10 MiB files each; rotation is finite local diagnostics, not a second telemetry service. The application completion logger runs before body parsing and admission so denied requests are counted without logging URLs, headers or bodies. Local Compose supplies both origin values from its selected port. Azure requires production mode, HTTPS for the single origin, complete `TENANT_ID`/`CLIENT_ID`/`CLIENT_SECRET` configuration, and a session secret of at least 32 bytes. App Service identity selects the trusted Azure proxy boundary; role or administrator bootstrap environment variables are not supported and cannot assign authority.

Supply the non-secret tenant/client GUIDs using `-TenantId` and `-ClientId`. Supply the client secret only through `-ClientSecretFile` pointing to an existing ignored restricted file, or enter it directly at the script's secure PowerShell terminal prompt. Never pass its value as a parameter or through chat. The existing helper copies it to `.local/<project>/secrets/client-secret` with owner-only permissions (Unix mode 0600); directories are restricted. Runtime mounts only that file, `session`, and `postgres-app`. The operator alone mounts `postgres-admin`. Generated DB/session secrets are reused, not silently rotated; missing/corrupt secrets with an existing volume stop for recovery. No provider token or MSAL cache file is created.

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

The wizard verifies registration differences and an Administrator assignment but never changes directory configuration, consent, API grants, app roles or provider roles. An authorized administrator applies any approved registration change separately and reruns preflight. The local-only Phase 12 implementation did not invoke Azure, Entra or a provider.

## Capability enablement

An Agent Control Administrator can explicitly enable an application-mode capability with approved tenant-shared scope; this does not grant Entra/provider permissions or deploy its adapter. Authenticated users can request their own non-mutating probe for delivered read adapters after approved consent. Later integrations register their own adapters, and write qualification is independent per capability. No configuration endpoint enables unqualified preview writes, schedules collection, or substitutes application credentials for delegated authorization.

Power Platform inventory is delegated-only. An authorized administrator separately permits dynamic consent for Power Platform API application ID `8578e004-a5c6-46e7-913e-12f58912df43`, delegated scope `ResourceQuery.Resources.Read`; no grant is bundled into initial OIDC login or applied by repository scripts. Assign `AgentControl.Reader` plus one documented Entra role: Global Administrator, Power Platform Administrator, Dynamics 365 Administrator or Global Reader for full inventory, or AI Administrator/AI Reader for AI-scoped coverage. Built-in Power Platform RBAC is not a substitute. Conditional Access must permit the documented Resource Query path, including any Azure Resource Manager dependency reported by the provider.

Copilot Studio quarantine uses the same Power Platform application audience but a separate delegated consent group and exact scope, `CopilotStudio.AdminActions.Invoke`. Assign `AgentControl.Operator` and one current provider role: Global Administrator, AI Administrator or Power Platform Administrator. Environment Maker, Reader, ordinary Power Platform environment RBAC and application credentials do not authorize quarantine. A user who must both browse broad inventory and operate quarantine needs both independent Agent Control roles, Reader and Operator. Consent and a successful capability probe permit direct status reads; writes additionally require a current role-separated two-direction canary qualification. Do not enable a write by editing capability evidence or database rows.

The delivered adapter targets global `api.powerplatform.com` only. Sovereign-cloud tenants must remain unsupported until a separately documented endpoint, audience and schema contract is implemented and qualified. Classic/V1 bots are excluded by the current inventory API; unpublished configuration, hidden workflow environments and preview connector/capability fields can remain absent. After consent and role assignment, use Permission Center's explicit probe and then Inventory Explorer's explicit refresh. Neither application startup nor navigation tests provider access.