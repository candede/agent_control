# Agent Control frontend

The React frontend is built into the Agent Control Express application. The
browser calls the Express API; it does not call Microsoft Graph or Power
Platform directly.

## Run locally

Use the repository-root workflow:

```powershell
pwsh ./deploy-local.ps1 start
```

The first start collects the Entra and port settings. Open the configured local
URL, which defaults to:

```text
http://localhost:3001
```

See the root [README](../README.md) and
[deployment setup](../docs/deployment-setup.md).

## Validate changes

Run the complete containerized software checks from the repository root:

```powershell
pwsh ./deploy-local.ps1 check
```

The check includes frontend lint, type checking, tests, and production builds.
No host Node.js installation is required.

## Main user flows

- **Agents**: browse inventory, inspect details and usage, manage package access,
  and review activity.
- **Users**: review licenses, activity, and agent relationships.
- **Sync**: refresh provider data and import Microsoft 365 usage reports.
- **Audit**: review administrative actions made through Agent Control.
- **Permissions**: check app roles, Microsoft roles, API permissions, consent,
  licensing, and provider access.

Provider changes require an Agent Control Admin, current provider authorization,
explicit confirmation, and post-change verification.

## Frontend structure

- `src/components/`: reusable UI and feature components
- `src/pages/`: page-level views
- `src/api/`: Express API clients
- `src/types/`: shared frontend types
- `src/test/`: test setup and helpers
- `browser/`: browser and layout tests
