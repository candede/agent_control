# Agent Control Azure Deployment Plan

Status: Ready for Validation

## Goal

Automate deployment of the Agent Control frontend and backend to Azure using Bicep and a cross-platform PowerShell script.

## Initial Decisions

- Frontend: Azure Static Web Apps Standard.
- Backend: Azure App Service Linux, single instance.
- Secrets: existing Azure Key Vault, one vault per environment, with required secrets already present.
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

## Architecture Notes

The current backend uses SQLite for audit logging and in-memory Express sessions. The first Azure deployment intentionally keeps the backend to one App Service instance and stores SQLite data under `/home/data/agent-control`. Scale-out requires replacing SQLite audit storage and in-memory sessions with shared services.

Static Web Apps proxies linked App Service backends only under `/api/*`. The backend auth routes and frontend links now use `/api/auth/login`, `/api/auth/callback`, and `/api/auth/logout` so the production redirect URI can be `https://<static-web-app-host>/api/auth/callback`.

Key Vault is used for `CLIENT_SECRET` and `SESSION_SECRET`. Non-secret deployment configuration stays in App Service settings. The deployment script does not create or modify the Entra app registration, create the Key Vault, or write Key Vault secrets. It only references existing secrets and grants the backend App Service managed identity read access to the existing vault.

## Validation Plan

- Run backend tests and typecheck.
- Run frontend lint and build.
- Run root build.
- Build Bicep template.
- Smoke test deployed `/api/health`, sign-in, agent list, and audit persistence after deployment.
