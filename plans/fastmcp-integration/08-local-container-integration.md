# 08 - Local container and lifecycle integration

## Mission and inputs

Package MCP from [05](05-fastmcp-service-and-auth.md)–[07](07-mcp-agent-controls.md)
and extend the existing local deployment owner. Read
[operations](../../docs/operations.md),
[04C](04C-api-webapp-production-release.md), [Compose](../../compose.yaml),
[local deployment](../../scripts/local-deployment.ps1) and
[runtime](../../scripts/local-runtime.ps1). This phase implements isolated
tooling; [12](12-production-convergence.md) owns the authorized live release.

## Implementation

1. Add a minimal non-root MCP runtime/test image with pinned dependencies and
   approved feed configuration. No credentials in image layers.
2. Add an explicitly configured Compose MCP service with an internal API
   address, dedicated loopback port, least-privilege secret mounts, encrypted
   OAuth state volume, health/readiness and resource/log limits. Preserve
   `seha_data`; no-MCP projects must still start normally.
3. Keep browser/public OAuth origins separate from internal addresses. Validate
   exact callbacks/proxy trust; no permissive forwarding or Origin/CSRF change.
4. Extend existing setup/edit-config/build/start/stop/check/recovery flows,
   artifact identities and resumable receipts rather than adding another owner.
   Missing optional MCP config provisions nothing; invalid supplied config fails.
   Do not add a second runtime enable/acceptance step for configured tools.
5. Verify encrypted storage permissions/persistence/bounds, independent key
   rotation, draining, API restart credential loss and explicit same-user job
   recovery. Never persist API provider credentials.
6. Reuse current-only installation/backup/reset semantics. MCP installation
   does not reset data, migrate old schemas or authorize destructive retry.
7. Document endpoint, registration, ingress, onboarding, protected key/state
   backup and exact targeted cleanup. Public ingress/tunnels are separate
   authorized changes, never created automatically.
8. Keep npm, Python, build stages and install hooks on the approved feeds.
   Preserve project/port/volume isolation and verify labels before lifecycle work.

## Verification and handoff

Extend current PowerShell deployment/runtime tests and MCP integration fixtures.
In an authorized disposable project validate image/Compose config, non-root
runtime, health plus authenticated calls, cold/restart/shutdown, encrypted
persistence, denied credentials and API/web availability with MCP stopped.
Test current/empty schema and incompatible-schema refusal without implicit reset.

Record measured resource limits and unavailable infrastructure honestly. Clean
only exact owned fixtures; no prune or production mounts. Source-only work uses
mocks and does not start infrastructure. Update current setup/operations;
[09](09-client-workflows-and-evaluation.md) consumes the endpoint and
[10](10-azure-deployment-integration.md) consumes the image/storage contract.
