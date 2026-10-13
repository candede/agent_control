# 08 - Local container and lifecycle integration

## Mission

Deliver a reproducible non-root MCP image and integrate it into the existing Compose/local setup, checks, restart, and recovery workflows without disrupting the API/frontend/database.

## Prerequisites

Read [README](README.md), [05](05-fastmcp-service-and-auth.md), [06](06-mcp-read-tools.md), [07](07-mcp-agent-controls.md), and their completion records. Inspect status and current deployment tooling before edits.

## Read first

- [Main Dockerfile](../../Dockerfile), [Compose](../../compose.yaml), [local entry point](../../deploy-local.ps1), [local deployment](../../scripts/local-deployment.ps1), [local runtime](../../scripts/local-runtime.ps1).
- [Local deployment tests](../../scripts/local-deployment.tests.ps1), [runtime tests](../../scripts/local-runtime.tests.ps1), [restart tests](../../scripts/restart-runtime.tests.ps1), [persistence tests](../../scripts/persistence.tests.ps1).
- [Setup](../../docs/deployment-setup.md), [operations](../../docs/operations.md), [root README](../../README.md), new Python package/lock and storage configuration from 05.

## Required implementation

1. Add a dedicated MCP Dockerfile with runtime/test stages, pinned Python/dependencies, approved feed configuration, non-root user, minimal runtime contents, deterministic lock installation, and no build-time credentials in layers.
2. Add the Compose MCP service using the internal API address, dedicated loopback port, least-privilege secret mounts, encrypted OAuth state volume, read-only runtime except that mount/tmp, dropped capabilities, resource/log limits, and health/readiness.
3. Keep browser API origin and MCP public OAuth base URL separate from internal service addresses. Validate exact callback/proxy/public URLs; do not relax portal Origin checks or trust arbitrary forwarded headers.
4. Extend local setup/edit-config to collect MCP non-secret settings and secure secret references only when MCP is explicitly configured. Preserve existing installation behavior when it is absent; omitted optional integration is not an error or a shadow implementation.
5. Wire image build/start/stop/check/restart into the existing scripts rather than a competing deployment system. Starting MCP must not synchronize data or mutate agents. Existing projects/ports/volume names remain isolated.
6. Add reproducible API/MCP integration fixtures to existing isolated Compose test conventions. Tests must not contact real tenants/provider endpoints unless separately approved.
7. Verify OAuth storage ownership, at-rest encryption, persistence, bounds, key/secret rotation behavior, shutdown draining, API restart authorization pause, and explicit same-user job recovery. Never persist API provider tokens to achieve restart continuity.
8. Document local MCP endpoint, registration/callback configuration, connection onboarding, status/reauthentication, backups of MCP keys/state, and targeted cleanup. Destroy only named disposable test resources; no reset of existing user projects/databases.
9. Keep Node/npm Docker registry settings and Python feed/lock settings aligned. Audit every dependency build stage/install hook for public-index bypasses.
10. Reuse the checkpointed audit/job/schema upgrade and no-MCP local path already released in 04C; extend them only for MCP integration. Test both already-upgraded Part 1 installations and fresh/exact-prior-schema installations, preserving historical unknown rows and avoiding double upgrade/reset. Prove the accepted web app operates with MCP stopped, and API/MCP restart preserves origin without persisting API provider credentials.

## Scope guard

No live tenant/provider writes, production deployment, broad local reset, new Redis/database/scheduler, public-by-default port exposure, app credential sharing, or conversion of the Node app to Python.

## Validation

- Add `scripts/mcp-local.tests.ps1`; run it with changed local deployment/runtime tests.
- Validate `docker compose config`, build the MCP runtime/test targets, run Python/API protocol fixtures through the container test path, and verify image user/secret/layer/runtime properties.
- Start an explicitly named synthetic disposable project; check health/readiness plus authenticated tool responsiveness, cold start, MCP restart, API restart, shutdown, state persistence, and denied requests.
- Test existing-schema origin upgrade without audit/job loss, browser versus MCP actions through the same routes, historical unknown display, attribution across restart/resume, and web/API responsiveness when the MCP container is unavailable.
- Attempt existing portal/API health and relevant browser/persistence tests; cleanup only that project's exact resources and record failures.
- Run `git diff --check`; install only through README feeds after manifest change/missing dependency.

## Production continuation

Apply README's Always-Deploy and accepted-Part-2 contracts. Docker/host/tool unavailability is truthful evidence carried to 11/12, not permission for public-feed fallbacks or bypass of user acceptance. Preserve the independently released API/web path and specific containment/recovery signals; local cleanup failures remain active incidents.

## Completion record

Write `completions/08-local-container-integration.md`: image/Compose/settings/secret contracts, exact local commands, restart/persistence/effective-feed proof, root impacts, checks, cleanup outcomes, and Azure mount/resource requirements.

## Done and handoff

Customers can start the MCP container alongside their existing app without changing portal semantics. 09 has a real local endpoint for client tests; 10 has a reproducible image and measured persistence/network requirements.
