# Agent Control Azure Deployment Plan

Status: Validated

## Goal

Automate deployment of the Agent Control frontend and backend to Azure using Bicep and a cross-platform PowerShell script.

## Initial Decisions

- Frontend: Azure Static Web Apps Standard.
- Backend: Azure App Service Linux, single instance.
- Secrets: existing Azure Key Vault, one vault per environment, with required secrets already present.
- Key Vault networking: selectable `Public` or `Private` deployment mode. `Public` remains the backward-compatible default; `Private` creates dedicated network resources and disables the vault public endpoint after deployment.
- Automation: `deploy-production.ps1` deploys Azure app resources, wires App Service settings to existing Key Vault secrets, and deploys frontend/backend code.
- App registration: existing Entra app registration only. It must already have the required delegated Microsoft Graph permissions and tenant-wide admin consent.
- Domains: Azure default domains first.

## Implementation Checklist

- [x] Update app routes for Static Web Apps `/api/*` backend proxying.
- [x] Add Static Web Apps runtime configuration.
- [x] Add Bicep infrastructure.
- [x] Reference existing Key Vault secrets from App Service settings.
- [x] Add PowerShell production deployment script.
- [x] Update documentation.
- [x] Run validation checks.
- [x] Add conditional App Service and Key Vault private networking.
- [x] Add deployment-script orchestration and Key Vault reference validation.
- [x] Document public and private Key Vault networking modes.
- [x] Validate both template branches.

## Architecture Notes

The current backend uses SQLite for audit logging and in-memory Express sessions. The first Azure deployment intentionally keeps the backend to one App Service instance and stores SQLite data under `/home/data/agent-control`. Scale-out requires replacing SQLite audit storage and in-memory sessions with shared services.

Static Web Apps proxies linked App Service backends only under `/api/*`. The backend auth routes and frontend links now use `/api/auth/login`, `/api/auth/callback`, and `/api/auth/logout` so the production redirect URI can be `https://<static-web-app-host>/api/auth/callback`.

Key Vault is used for `CLIENT_SECRET` and `SESSION_SECRET`. Non-secret deployment configuration stays in App Service settings. The deployment script does not create or modify the Entra app registration, create the Key Vault, or write Key Vault secrets. It references existing secrets and grants the backend App Service managed identity read access to the existing vault.

`keyVaultNetworkAccess=Public` preserves the existing architecture and expects the existing vault to allow public data-plane access. `keyVaultNetworkAccess=Private` conditionally creates a dedicated virtual network, an App Service integration subnet, a private-endpoint subnet, a Key Vault private endpoint, the `privatelink.vaultcore.azure.net` private DNS zone, its VNet link, and a DNS zone group. The backend enables regional VNet integration and routes outbound traffic through the VNet. After Bicep completes, the deployment script disables public network access on the existing vault, refreshes App Service Key Vault references, and requires both configured references to resolve before code deployment continues.

Private mode uses configurable, non-overlapping CIDR prefixes with deployment-safe defaults. The private resources are additive and do not recreate or replace the existing Key Vault. Tenant-specific policy-exemption tags are outside the reusable deployment template and must be removed separately after private connectivity is verified.

## Validation Plan

- Run backend tests and typecheck.
- Run frontend lint and build.
- Run root build.
- Build Bicep template.
- Build the template with both `Public` and `Private` parameter modes.
- Smoke test deployed `/api/health`, sign-in, agent list, and audit persistence after deployment.

## Role Assignment Verification

- Status: Verified.
- Identity: backend App Service system-assigned managed identity.
- Role: `Key Vault Secrets User` (`4633458b-17de-408a-b874-0445c86b69e6`).
- Scope: the existing Key Vault resource only.
- Purpose: resolve the `CLIENT_SECRET` and `SESSION_SECRET` Key Vault references without granting secret write or vault management access.

## Validation Proof

- Date: 2026-07-21.
- Bicep template build: passed with zero diagnostics.
- Bicep parameter build: passed with zero diagnostics.
- PowerShell parser and `Public,Private` parameter contract: passed.
- Backend tests: 25 passed; backend typecheck passed.
- Frontend tests: 20 passed; frontend lint passed.
- Production build: passed; existing Vite chunk-size warning remains informational.
- Azure authentication: confirmed for subscription `6393f9f2-9fc6-4a73-8b43-a29fdb082dd7` and tenant `0be63a71-3e7b-46b4-902b-b4e60628020e`.
- Azure resource-group template validation: `Public` passed and `Private` passed.
- Azure what-if: `Public` proposed no network resources or deletes; `Private` proposed the expected VNet, two subnets, Key Vault private endpoint, private DNS zone/link/group, and App Service update with no deletes.
- Azure Policy: private mode aligns with the tenant management-group policy that modifies Key Vault public network access to `Disabled`.
- Patch validation: `git diff --check` passed.

## Post-Deployment Validation

- Confirm the Key Vault private endpoint connection is approved.
- Confirm Key Vault public network access is `Disabled`.
- Confirm both App Service Key Vault references report `Resolved`; the deployment script enforces this before packaging application code.
- Confirm `/api/health`, sign-in, agent list, and audit persistence through the Static Web Apps URL.
- Remove any tenant-specific Key Vault policy-exemption tag after private connectivity succeeds.
