# Agent Control Azure deployment

The supported production entry point is:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -TargetFile <approved-target.json>
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile <approved-target.json>
```

The deployment uses:

- one Linux App Service for the Express and React application;
- one PostgreSQL Flexible Server;
- one administrator-prepared Key Vault;
- the approved Entra app registrations and callback URL.

Prepare and review the approval file before running either action. The Plan
action validates the target and runs Bicep what-if. Deploy requires the same
approved target.

See [Azure production deployment](../docs/azure-production-deployment.md).
