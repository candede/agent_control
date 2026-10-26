# Azure production deployment

Production deployment uses `deploy-azure.ps1` to deploy the Express/React
application to Linux App Service with PostgreSQL Flexible Server and an
administrator-prepared Key Vault.

## Requirements

Install:

- PowerShell 7
- Docker
- Azure CLI
- Standalone [Bicep CLI](https://learn.microsoft.com/azure/azure-resource-manager/bicep/install#install-manually).
  The owner compiles locally, without authentication or a container download.

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

The prepared vault must contain these exact versioned secret names:

| Secret name | Consumer |
| --- | --- |
| `agent-control-tenants-json` | Application tenant registry |
| `agent-control-session-secret` | Application sessions |
| `agent-control-postgres-admin-password` | Database operator only |
| `agent-control-postgres-app-password` | Application database role |

Only the three rows other than `agent-control-postgres-admin-password` are
provided to the application runtime. The operator password must never appear
in its environment or runtime secret references.

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
3. Confirm initial read-only synchronization starts automatically after sign-in.
4. Review **Sync** source progress; use **Permissions** for actual access failures.
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

## Optional independent MCP App Service

This is **source deployment support**, not evidence of an Azure deployment.
The roadmap production target remains local Compose `seha`. Nothing here
authorizes login, resource/secret reads, image publication, grants, networking
or provisioning. Obtain exact target/action/content/budget approval first.
Missing `mcp` in the existing version-2 target provisions no MCP resources.
Supplied null, empty, partial, unknown or invalid configuration fails; it is
never silently treated as absent.

Place a completed [MCP object example](../infra/mcp-target.example.json) at the
target's `mcp` property. This is a **fragment**, not another target format or an
approval. Keep the ordinary target/tenant-registry, estimate and maintenance
contracts. Use the production image stage, reviewed source identity and exact
`<approved ACR>/<repository>@sha256:<digest>`, never a tag. The source image runs
UID/GID10001 and one Uvicorn process; no provider/SQL/API credentials enter it.

The existing owner supports:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -TargetFile <approved-target.json>
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile <same-approved-target.json>
# Independent MCP change: does not build/deploy/stop Node or touch PostgreSQL.
pwsh ./deploy-azure.ps1 -Action Plan -Component Mcp -TargetFile <approved-target.json>
pwsh ./deploy-azure.ps1 -Action Deploy -Component Mcp -TargetFile <same-approved-target.json>
# Exact existing MCP writer stop/drain for an approved backup window:
pwsh ./deploy-azure.ps1 -Action Stop -Component Mcp -TargetFile <approved-existing-target.json>
# Retry only after checking the failed receipt's exact outcome:
pwsh ./deploy-azure.ps1 -Action Deploy -Component Mcp -TargetFile <same-approved-target.json> `
  -ResumeReceiptPath <failed-receipt.json>
```

`All` is the default component. `Application` requires a target without `mcp`;
it cannot ignore supplied MCP configuration. MCP-only needs PowerShell, Azure
CLI and Bicep, not Docker or an API ZIP. Application deploy still uses its
existing artifact, current-schema installer, backup, maintenance and recovery
owner. `infra/main.bicep` remains Node/PostgreSQL-only.
`infra/mcp.bicep` is applied separately **after** API/web is open. Its failure
records `deployed_mcp_failed`/`recovered_mcp_failed`, attempts to stop only MCP,
and leaves API/web online. The CLI exits nonzero for those partial outcomes.
Resume preserves the exact target/component/digest/version/storage identity;
completed apply is not repeated, but the stopped MCP service is started again.
An uncertain ARM apply remains non-replayable until the operator reconciles
the actual resource/digest/mount/reference outcome. It is not a reset request.

### Prepared identities, storage and network

The only provisioned MCP resources are its separate single-worker Linux **S1**
plan, custom-container site, per-secret runtime Key Vault grants, diagnostics
and finite metric alerts. ACR, user-assigned identity, premium file account/share,
private endpoint, VNet/subnets/NSGs/private DNS, existing action group and vault
must already be separately authorized and prepared. The tool never publishes
images, creates registry/identity/network/storage, retrieves storage keys,
passes registry passwords, or changes Entra registrations/consent.

- Bind the same tenant and existing API GUID/origin. The API's protected tenant
  registry must already contain exactly this MCP integration client, scalar API
  audience and `AgentControl.Access`. Full Plan checks it in the existing
  registry owner. MCP-only does not read API secrets: its reviewed registration/
  network references and the live API remain authoritative. Readiness is **not**
  proof of authenticated OBO/API connectivity.
- The initial public resource is exactly
  `https://<mcp-site>.azurewebsites.net/mcp`, Entra return is origin-root
  `/auth/callback`, and SDK discovery issuer includes the trailing `/`.
  Client callbacks are the distinct, exact1–32 HTTPS/HTTP-loopback redirects
  from [client onboarding](mcp-clients.md), never wildcard callbacks. Custom
  domains/front doors/extra proxies are not implemented by this profile.
- Prepare the user-assigned identity in the same tenant/subscription with
  existing `AcrPull` on the exact registry. Disable ACR admin credentials.
  Only that exact grant, the object-conditioned Blob grant below and
  `Key Vault Secrets User` on the three exact MCP secret scopes are supported.
  The owner rejects broad, inherited or custom
  grants (including group-derived assignments), including management-plane
  access that could obtain API secrets. The owner queries both subscription
  descendants and inherited parent/management-group assignments, with group
  membership included and principal-name enrichment disabled. The approved
  operator needs that role metadata visibility; enumeration failure is a
  failure, not a clean result.
  The profile uses registry RBAC/AcrPull, not ACR repository-ABAC permissions.
  The template grants access only to `agent-control-mcp-client`,
  `agent-control-mcp-signing`, `agent-control-mcp-encryption`; selected versions
  are immutable. Native Key Vault references use that identity. No secret values
  enter parameters, command arguments or receipts. The Python Azure source
  accepts only resolved values in memory, with the same independent-key and
  format checks; it never falls back to local files or plaintext OAuth state.
  Inherited access to any API/session/database/tenant-registry secret is refused.
- Azure uses **one prepared Block Blob**, not a filesystem mount or the
  application's database. Pin the exact HTTPS account URL, dedicated private
  container and `oauth-state.v1.fernet` object. `storage.identity` is this exact
  object URL, not an invented marker file. Prepare a same-region `StorageV2`
  Standard_LRS/ZRS account with HTTPS-only, TLS1.2, shared-key authorization and
  public Blob access disabled, and public network access disabled. The container
  has `publicAccess=None`. The storage owner creates the empty Block Blob once,
  or supplies the intact same-binding encrypted object on recovery.
  The runtime never creates containers/objects or falls back to local storage.
- Prepare `Storage Blob Data Contributor`
  (`ba92f5b4-2d11-453d-a403-e96b0029c9fe`) on **only** the exact container
  resource ID, with conditionVersion `2.0` and the exact condition:

  ```text
  @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringEquals 'oauth-state.v1.fernet'
  ```

  No unconditioned/other-object/account/subscription Blob grant is accepted.
  The dedicated container contains no other data. The existing deployment
  owner verifies already-prepared storage/registry grants; it does not create
  them. The runtime uses only `ManagedIdentityCredential(client_id=<exact UAMI>)`,
  never `DefaultAzureCredential`, user/environment credentials, SAS or keys.
  Native Key Vault secret delivery remains separate from this SDK credential.
- Prepare the exact approved `blob` private endpoint in the integration VNet,
  its `default` private DNS zone group for `privatelink.blob.core.windows.net`,
  and completed non-registering link to that VNet. The Web/serverFarms-delegated
  integration subnet and `vnetRouteAllEnabled=true` route outbound traffic
  through the prepared network. Record effective private DNS, HTTPS443 to the
  endpoint and bounded firewall/NSG/route egress to Entra, the exact API, Key
  Vault and ACR dependencies in `preparedReference` and the existing network
  reachability reference. Do not open public storage or weaken TLS to fix DNS.
  ARM identity checks do not prove effective packets/DNS; the network owner must
  verify these on the authorized target before claiming cloud qualification.
- The exact data blob is also the lease object. Startup acquires a finite15s
  SDK lease once; a competing worker fails startup. Renew every4s only during
  service lifespan. Every read/authorization boundary verifies ownership;
  every persisted mutation uses the same blob lease plus ETag condition.
  No guard-blob/unfenced-key design, stale authorization cache, automatic
  reacquisition or mutation retry exists. Each SDK I/O is bounded5s with SDK
  retries disabled; a local10s ownership deadline starts at request dispatch,
  not response receipt. Expired/unknown ownership or any ambiguous mutation
  permanently stops this process's issuance and readiness, with safe503 and
  redacted operator logging. Stop and reconcile; never replay cached success.
  Shutdown cancels renewal and attempts bounded release; after a crash wait for
  finite lease expiry, never break an active holder to force replacement.
- The encrypted map permanently binds tenant/MCP/API/resource and exact storage
  object, with hashed lookups, maintained Fernet/MultiFernet encryption,4096
  records,256KiB per record,24h maximum TTL and expiry culling on mutations/
  readiness. Serialized plaintext is bounded below48MiB so encrypted bytes
  stay below64MiB; one bounded single-Put-Blob update avoids unfenced block
  staging. No business, provider or API/OBO credential state moves here.
  Local protected FileTree/Fernet behavior and ownership/modes are unchanged.

See Microsoft's [Blob lease SDK](https://learn.microsoft.com/python/api/azure-storage-blob/azure.storage.blob.aio.blobleaseclient),
[lease protocol](https://learn.microsoft.com/rest/api/storageservices/lease-blob),
[ABAC examples](https://learn.microsoft.com/azure/storage/blobs/storage-auth-abac-examples)
and [private endpoints](https://learn.microsoft.com/azure/storage/common/storage-private-endpoints).
One site/worker/no-slot/no-autoscale remains capacity policy, not fencing.
Verified stop plus75s drain remains useful for owner-managed updates, but the
server-enforced data-blob lease fences platform replacement independently.
`scripts/azure-oauth-fixture.ps1` proves real SDK/emulator lease semantics on a
guarded internal Docker network with a loopback-only port and exact cleanup.
It does not prove Azure managed identity, ABAC, TLS/private DNS or durability.

### Transport and proof boundaries

Ingress is HTTPS/TLS1.2, explicit IPv4 CIDR allows with default deny; SCM defaults
deny. Preserve the public Host through App Service. Uvicorn ignores all forwarded
headers; neither Node's proxy policy nor browser Origin/CSRF rules are widened.
The SDK keeps exact Host/Origin/resource/audience/PKCE checks.
The current Streamable HTTP profile returns bounded JSON responses, not an
unbounded SSE event broker. Invocation deadline60s, API deadline30s/OBO10s,
request/output512KiB,32 connections/backlog64, OAuth/body30s, callback16KiB,
keepalive5s, graceful drain65s and host stop75s remain explicit. Azure's Linux
approximately230-second front-end idle boundary is not a configurable promise
of long-lived streaming. No buffering/reverse-proxy setting is invented.

Deployment verifies observed image/Blob binding/egress/ingress/native references,
runtime binding, redacted diagnostics/alerts, encrypted readiness and public
OAuth discovery. It explicitly records authenticated API connectivity, actual
Azure persistence/restart, disconnect/streaming/client compatibility as
**not proven**. Exact approved accounts/network must test OAuth→OBO→a saved read,
revocation, restart/lease-expiry/host replacement, key rotations, callback rejection,
spoofed forwarding, bounded streaming/cancellation and graceful drain. No test
receipt is a runtime enable flag or substitute for real authorization.

### Signals and owning responses

MCP metric alerts use the existing bounded30-day/0.1GiB-day workspace and action
group: >=5 HTTP5xx/5min, health<100%/5min, average latency>2s/5min,
working memory>768MiB/5min. No raw HTTP/query/callback/token logging is enabled.
These are configured thresholds, not measured capacity or delivered-alert proof.
The platform health metric is a0–100 average; by default it reflects unhealthy
status only after ten failed one-minute pings, before the five-minute alert
window. Readiness503 can appear earlier; do not infer immediate detection.
See [Health Check behavior](https://learn.microsoft.com/azure/app-service/monitor-instances-health-check)
and [the metric unit clarification](https://learn.microsoft.com/en-us/answers/questions/1551682/what-is-the-unit-for-health-check-metric).

| Signal/limit | Owner and response |
| --- | --- |
| Repeated401/403, rejected callback/resource/PKCE, claims challenge | Identity owner checks exact tenant/client/scope/redirect/grant or same-account reconnect. Do not widen audience/Origin or log codes/tokens. |
| OBO/API503/504, invocation60s, API30s/OBO10s | MCP/API owner distinguishes token service from authenticated API reachability; inspect sanitized correlation/status, network and current permissions. No app-only fallback or POST retry. |
| Provider429/503/errors or schema omissions | API/provider owner observes existing provider-failure alerts (>=5/5min), cooldown and saved job state. Saved reads stay provider-free. |
| Sent-unknown/readback-pending/partial control | Control owner uses saved exact receipt/job and read-only reconciliation; never execute/replay an uncertain write to “test recovery.” One safety incident requires incident handling. |
| Authorization-wait or queued work beyond its documented API deadline | API/job owner reacquires fresh same-account authority for eligible unsent work; use current saved status. No MCP queue/scheduler or invented approval. |
| OAuth >=80% of4096 records or64MiB; readiness503 or lost-lease log | MCP storage owner uses authenticated `/diagnostics` record/encrypted-byte usage and expired-state culling. Stop the failed process; reconcile the exact object/ETag and active holder before restart. Never break a live holder, replay an uncertain write or broaden permissions. |
| Latency/memory/CPU/restarts | MCP owner checks configured metric alerts and S1 plan CPU; investigate sustained CPU>80%/15min or >2 restarts/15min. Stop only MCP for containment; no unapproved scale-out. |
| Spend actual/forecast80% of approved ceiling or extra shared-resource charge | Budget owner checks the existing budget notices, MCP's separately itemized plan/storage/registry/network/monitoring/restore cost and other-RG prepared-resource costs. Escalate forecast before100%; do not silently provision/upgrade. |

Disk/queue/auth-specific thresholds above are operator runbook responses, not
fabricated installed Azure log alerts: the current SDK emits normalized safe
logs, not a new analytics schema. Delivery, effective NSG/DNS, billing outside the
deployment RG, API-authenticated reachability and restart observations are
external owner actions. MCP failure must never turn off API/web or request a
database reset.
