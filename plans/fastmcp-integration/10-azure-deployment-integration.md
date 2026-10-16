# 10 - Azure hosting and deployment tooling

## Mission and inputs

Extend Azure tooling for a future separate MCP container App Service beside the
Node API/web App Service. Production for this roadmap remains current-host
`seha`; this is not a live cloud migration.
Read [05](05-fastmcp-service-and-auth.md), [08](08-local-container-integration.md),
[09](09-client-workflows-and-evaluation.md),
[Azure guide](../../docs/azure-production-deployment.md),
[deployment owner](../../scripts/azure-deployment.ps1),
[Bicep](../../infra/main.bicep) and
[recovery](../../infra/disaster-recovery.md).

## Implementation

1. Preserve the existing Node/PostgreSQL topology and add explicit support for
   one non-root MCP custom-container instance. Missing MCP config provisions
   nothing; invalid supplied config fails. Do not maintain duplicate old/new
   deployment implementations.
2. Extend current target/resource contracts for exact MCP image digest,
   registry/plan, tenant/API binding, public callback/origin, storage, secret
   versions, ingress, monitoring and cost. Examples are not live authorization.
3. Use immutable registry image digests and supported managed identity/Key Vault
   access. Secrets stay out of parameters, arguments, logs and receipts.
   Additional plan/storage/network/registry resources need real authorization.
4. Support dedicated access-restricted encrypted OAuth storage and independent
   keys with single-writer ownership. Do not claim Azure persistence from Compose
   restart or use ephemeral container storage as durable state.
5. Validate forwarded-header trust, streaming/buffering/timeouts, callbacks,
   disconnects, request/resource bounds and authenticated API connectivity.
   Never widen audiences, callback wildcards or browser CSRF/Origin rules.
6. Reuse current Plan/Deploy/artifact/receipt/resume/rotation/recovery owners and
   current-only empty/current schema installation. No implicit reset, old-schema
   adapter, second migration owner or release-file runtime gate.
7. Document monitoring/alerts and owning responses for auth/API/provider errors,
   uncertain readback, queue/authorization wait, OAuth disk, latency/resources
   and spending. MCP failure must not disable the independent API/web path.

## Verification and handoff

Extend existing mocked Azure deployment tests; validate Bicep with available
local tooling. Cover target mismatch, secret/network/image contracts,
Plan/Deploy/resume, rotation/recovery and no-MCP behavior. Current data/audit/jobs
must be preserved and uncertain writes non-replayable.

Cloud what-if, registry, Key Vault, persistence and streaming proof require their
own authorized target; absent access is unavailable, not local release failure.
Do not provision anything as part of source-only work or make cloud access a
prerequisite for [12's Compose release](12-production-convergence.md).
Update current Azure/recovery docs with implemented contracts and exact results.
