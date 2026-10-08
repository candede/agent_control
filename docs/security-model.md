# Security model

Agent Control uses Microsoft Entra ID for authentication, app roles for product
authorization, and provider permissions for Microsoft operations.

## Identity and tenant routing

Users enter a work or school username before sign-in. The exact configured
domain selects one tenant profile and Entra app registration.

- Unknown or overlapping domains are rejected.
- Each tenant has separate credentials and accepted domains.
- The verified tenant and account from Entra establish identity.
- Client-supplied identity headers are not trusted.

See [deployment setup](deployment-setup.md).

## App roles

Agent Control has two app roles:

| Role | Access |
| --- | --- |
| `AgentControl.Viewer` | View authorized inventory, reports, and investigations |
| `AgentControl.Admin` | Viewer access plus supported changes, imports, and configuration |

Set **Assignment required?** to **Yes** on the Enterprise application. Assign
each approved user or group one role.

App roles do not grant Microsoft Graph, Power Platform, Purview, or Defender
access. Those providers still enforce their own permissions, roles, licenses,
policies, and data scope.

## Tenant and account isolation

Saved provider data is partitioned by tenant and, where required, by the account
that collected or authorized it.

- One tenant cannot read or change another tenant's data.
- Private delegated evidence is not shared between accounts.
- Application-mode data is available only within its approved tenant scope.
- Exact current inventory identity is required before provider changes.

## Sessions

Sessions are stored server-side and use secure, HTTP-only cookies in production.
The browser receives only the information needed to render the signed-in
experience.

Role and tenant configuration changes require a new sign-in. Runtime checks also
reject sessions whose tenant or application binding no longer matches current
configuration.

## Browser request protection

State-changing browser requests require:

- a valid authenticated session;
- the required Agent Control role;
- same-origin checks;
- a current CSRF token;
- validated request data;
- explicit confirmation for provider changes.

Provider changes also recheck the exact target, current authorization, current
inventory authority, provider prestate, and provider readback.

## Provider credentials and permissions

Delegated tokens are acquired for the signed-in account and requested only for
the operation being performed. Optional application permissions must be
configured and enabled separately.

Agent Control does not:

- accept provider access tokens from the browser;
- grant consent during sign-in;
- treat a client secret as provider authorization;
- infer permission from a successful login;
- report unavailable provider data as a successful empty result.

Use **Permissions > Check status** to inspect current readiness. Providers make
the final authorization decision when an operation runs.

## Data handling

Agent Control stores the minimum provider data needed for inventory, reports,
investigations, jobs, and audit.

- Secrets stay in protected local files or Azure Key Vault.
- Tokens and raw provider credentials are not returned to the browser.
- Logs avoid request bodies, authorization headers, and secret values.
- CSV uploads and exports are bounded and retained for limited periods.
- Administrative actions are recorded in the local audit log.

## Durable jobs

Long-running synchronization, investigation, and provider-change jobs keep
bounded progress and results. Interrupted work is recovered only when the
operation is safe to resume. A provider write with an uncertain outcome is not
sent again automatically.

## Deployment

Local deployment binds the frontend and API to one origin. Azure deployment uses
HTTPS, App Service, PostgreSQL, and versioned Key Vault references.

Run software checks before release:

```powershell
pwsh ./deploy-local.ps1 check
```

See [operations](operations.md) and
[Azure production deployment](azure-production-deployment.md).
