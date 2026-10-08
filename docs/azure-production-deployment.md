# Azure production deployment

Production deployment uses `deploy-azure.ps1` to deploy the Express/React
application to Linux App Service with PostgreSQL Flexible Server and an
administrator-prepared Key Vault.

## Requirements

Install:

- PowerShell 7
- Docker
- Azure CLI

The deployment operator needs:

- deployment access to the target subscription and resource group;
- permission to read the selected Key Vault secret versions;
- permission for Key Vault template deployment;
- permission to review the Entra app registration and assignments;
- the approved App Service and PostgreSQL network configuration.

Configure every Entra application by following
[Deployment setup](deployment-setup.md). Production callback URLs must use HTTPS:

```text
https://<app-host>/api/auth/callback
```

## Prepare Key Vault

The prepared vault must contain versioned secrets for:

- the tenant registry;
- the application session secret;
- the operator database password;
- the runtime database password.

The tenant registry contains the tenant ID, client ID, client secret, accepted
domains, and optional display name for every tenant. Keep secret values out of
source control, shell arguments, approval files, deployment receipts, and logs.

## Prepare the approval file

Copy `infra/production-target.example.json` to an access-restricted location
outside source control and complete it with:

- tenant, subscription, resource group, and region;
- Entra application and callback details;
- App Service, plan, PostgreSQL, database, and Key Vault resource IDs;
- exact Key Vault secret versions;
- tenant-registry approval reference;
- network addresses and rules;
- monthly estimate and budget;
- change approval and maintenance window;
- installation mode: `fresh` or `existing`.

Use `fresh` only for an empty application database. Use `existing` only for an
installation already running the current application schema.

Agent Control uses a Burstable PostgreSQL tier for this deployment profile.
Review Microsoft's
[PostgreSQL compute guidance](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-compute),
record the expected workload and cost, and approve a different tier when the
workload requires it.

## Preview the deployment

Authenticate Azure CLI to the approved tenant and subscription, then run:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -TargetFile <approved-target.json>
```

Plan validates the target, secret references, Entra configuration, resource
identities, artifact checksum, pricing evidence, and Bicep what-if. It does not
change Entra roles, assignments, permissions, or consent.

Review the redacted output and resolve every failure before deployment.

## Deploy

Use the same approved target file:

```powershell
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile <approved-target.json>
```

Deployment requires the approved target to match the preview. Keep the generated
receipt with the release records.

## Verify the release

After deployment:

1. Confirm `/api/health` and `/api/ready` return success.
2. Sign in with an assigned Viewer account and an assigned Admin account.
3. Open **Permissions** and check the required capabilities.
4. Refresh each enabled source from **Sync**.
5. Verify saved inventory, users, reports, and activity.
6. Test each approved write with an exact reviewed target.
7. Confirm monitoring, backup retention, budget alerts, and network rules.

## Operate the deployment

- Keep Key Vault, App Service, PostgreSQL, and Entra changes under the approved
  change process.
- Use versioned Key Vault references and obtain approval before rotating
  credentials.
- Review PostgreSQL CPU credits, memory, storage, connections, and query latency.
- Keep provider permissions and app-role assignments limited to approved users.
- Use PostgreSQL point-in-time restore for Azure recovery and verify access scope
  before reopening provider work.
- Run `Plan` again whenever the target, resource tier, network, secret version, or
  estimate changes.
