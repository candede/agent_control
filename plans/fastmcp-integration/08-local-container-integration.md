# 08 - Local container and lifecycle integration

## Mission

Deliver a reproducible non-root MCP image and extend the already released `seha` Compose deployment/setup/check/restart/recovery contracts, without disrupting the API/frontend/database. This phase implements and tests tooling in isolated projects; 12 performs the live release.

## Prerequisites

Read [README](README.md), [04C](04C-api-webapp-production-release.md), [05](05-fastmcp-service-and-auth.md), [06](06-mcp-read-tools.md), [07](07-mcp-agent-controls.md), and their completion records. Inspect the accepted `seha` release/approval boundary, status and current deployment tooling before edits.

## Read first

- [Main Dockerfile](../../Dockerfile), [Compose](../../compose.yaml), [local entry point](../../deploy-local.ps1), [local deployment](../../scripts/local-deployment.ps1), [local runtime](../../scripts/local-runtime.ps1).
- [Local deployment tests](../../scripts/local-deployment.tests.ps1), [runtime tests](../../scripts/local-runtime.tests.ps1), [restart tests](../../scripts/restart-runtime.tests.ps1), [persistence tests](../../scripts/persistence.tests.ps1).
- [Setup](../../docs/deployment-setup.md), [operations](../../docs/operations.md), [root README](../../README.md), new Python package/lock and storage configuration from 05.

## Required implementation

1. Add a dedicated MCP Dockerfile with runtime/test stages, pinned Python/dependencies, approved feed configuration, non-root user, minimal runtime contents, deterministic lock installation, and no build-time credentials in layers.
2. Add the Compose `mcp` service using the internal API address, dedicated loopback port, least-privilege secret mounts, encrypted `mcp_oauth` volume (effective `seha_mcp_oauth` in production), read-only runtime except that mount/tmp, dropped capabilities, resource/log limits, and health/readiness. Keep the existing `seha_data` volume untouched and no-MCP projects valid.
3. Keep browser API origin and MCP public OAuth base URL separate from internal service addresses. Validate exact callback/proxy/public URLs; do not relax portal Origin checks or trust arbitrary forwarded headers.
4. Extend local setup/edit-config to collect MCP non-secret settings and secure secret references only when MCP is explicitly configured. Preserve existing installation behavior when it is absent; omitted optional integration is not an error or a shadow implementation.
5. Wire image build/start/stop/check/restart, pinned source/image IDs, separate release approval and resumable receipt into the existing scripts rather than a competing deployment system. Configure 05's server tool allowlist locally and record effective exposure; omitted tools must fail direct invocation. Starting MCP must not synchronize data or mutate agents. Existing projects/ports/volumes remain isolated; verify exact labels before any lifecycle action.
6. Add reproducible API/MCP integration fixtures to existing isolated Compose test conventions. Tests must not contact real tenants/provider endpoints unless separately approved.
7. Verify OAuth storage ownership, at-rest encryption, persistence, bounds, key/secret rotation behavior, shutdown draining, API restart authorization pause, and explicit same-user job recovery. Never persist API provider tokens to achieve restart continuity.
8. Document local MCP endpoint, exact registration/callback/public-origin configuration, connection onboarding, status/reauthentication, protected backups of keys/state and targeted cleanup. Implement bounded trust/routing configuration for an explicitly approved existing HTTPS ingress, if available; new ingress/public exposure requires separate operator approval under README. No automatically created tunnels or public ports. Destroy only exact named disposable test resources; never reset `seha` or existing user projects/databases.
9. Keep Node/npm Docker registry settings and Python feed/lock settings aligned. Audit every dependency build stage/install hook for public-index bypasses.
10. Reuse the checkpointed audit/job/schema upgrade and no-MCP local path already released in 04C; extend only for MCP integration. Test already-upgraded Part 1, fresh and known-baseline installations through the same chain, preserving historical unknown rows and avoiding double upgrade/reset. Prove the accepted web app works with MCP stopped and API/MCP restart preserves origin without persisting API provider credentials. Measure fixed host/container capacity and choose concrete startup/streaming/observation thresholds for 11/12; unknown results stay unknown.

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

Write `completions/08-local-container-integration.md` under README's completion contract: image/Compose/settings/secret/allowlist/ingress contracts, exact preflight/build/deploy/resume/backup commands for 12, runtime identities/resource ceilings, restart/persistence/effective-feed proof, root impacts, checks, cleanup outcomes, and separate Azure tooling requirements.

## Done and handoff

Customers can start the MCP container alongside their existing app without changing portal semantics. 09 has a real local endpoint for client tests; 10 has a reproducible image and measured persistence/network requirements.
