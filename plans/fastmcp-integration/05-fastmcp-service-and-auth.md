# 05 - FastMCP service and Entra authentication

## Mission

Implement the Python FastMCP service, authenticated Streamable HTTP transport, encrypted connection storage, audience-correct API token acquisition, and a typed bounded API client. Do not implement business tool families yet.

## Prerequisites

Read [README](README.md), [01](01-contracts-and-feasibility.md), [03](03-api-auth-integration.md), [03A](03A-shared-api-and-audit-origin.md), [04C](04C-api-webapp-production-release.md), and their completion records, plus `completions/PART-1-ACCEPTANCE.md`. Verify the actual user acceptance/start-Part-2 instruction matches the deployed API/web revision and no unresolved material Part 1 change invalidates it. If absent, stop before modifying MCP files, installing Python dependencies, or provisioning resources; ask for the actual response if needed. Use the accepted auth/route/origin contracts; inspect scoped status and worker instructions.

## Read first

- The integration document/fixtures from 01 and active API principal/credential code from 02/03.
- [Backend dependency conventions](../../backend/package.json), [root dependencies](../../package.json), [container feeds](../../Dockerfile), [configuration](../../backend/src/config.ts), [error contract](../../backend/src/errors.ts).
- [Security](../../docs/security-model.md), [deployment setup](../../docs/deployment-setup.md), and dated FastMCP AzureProvider/OAuthProxy/HTTP/storage plus supported Entra MSAL documentation.

## Required implementation

1. Create the new `mcp/` package with `pyproject.toml`, a reproducible pinned dependency lock, service/configuration/API-client modules, and pytest fixtures. Include only required FastMCP, HTTP/authentication, and test dependencies. Use maintained SDKs rather than custom OAuth/cryptography.
2. Configure a tenant-specific FastMCP AzureProvider/OAuth proxy with protected-resource/authorization discovery, fixed public callback/base URLs, PKCE and redirect/consent protections, and documented client registration support. Do not disable OAuth consent protections to accommodate scheduled calls.
3. Validate server configuration before readiness: exact API origin/tenant/registration binding, scopes/audiences, secret references, callbacks, deadlines, limits, and storage permissions. Implement the 01-frozen deployment-owned server tool allowlist with unknown-name rejection and direct-invocation denial for omitted tools; it never grants an operation or replaces API authorization. Never accept a tool-supplied API base URL or tenant switch.
4. Recover the verified upstream Entra access token using the pinned SDK's supported contract, then perform the 01-approved API-audience exchange. Never use FastMCP's client JWT as the assertion, forward tokens across audiences, or expose credentials through a tool.
5. Persist MCP OAuth clients/grants/tokens only through supported encrypted file-backed storage on the dedicated mount. Use independently managed signing/encryption keys so Entra client-secret rotation does not silently corrupt connection state. Document revocation, retention, disk bounds, startup failures, and safe key-rotation/reconnect behavior.
6. Keep API credentials and token exchanges request/principal/audience-bound and coalesced without account crossover. Propagate claims challenges/reauthentication, honor throttling, enforce bounded retry/deadline/cancellation, and avoid blocking the async loop with synchronous MSAL work.
7. Implement the typed API client with allowlisted canonical methods/routes also used by frontend adapters, input validation, response-envelope limits, cursor/provenance preservation, correlation IDs, and error mapping. No arbitrary HTTP endpoint tool, MCP-only API mirror, business SQL joins, or success-shaped exception fallback.
8. Expose health/readiness without identity/secrets and add a minimal authenticated diagnostic tool returning safe current-principal/capability metadata from the API. Bind every MCP session/tool request to validated credentials, never just `Mcp-Session-Id`.
9. Log safe operational metadata only: request/tool IDs, route/result codes, duration/bytes, and redacted dependency states. No tokens, cookies, client secrets, full UPNs, confidential About text, or request/response body dumps.
10. Document local service/test commands and OAuth registration/setup. Ensure new Python package/install configuration and all lock resolution use the approved feed exclusively.
11. Collect available calling-client context from the authenticated OAuth connection and MCP initialization/request metadata through supported pinned SDK APIs. Keep authenticated IDs distinct from reported names/version/calling-agent labels; avoid mutable global session context or a connection's last agent label leaking into another tool call.
12. Forward only 03A's bounded attribution descriptor to the API over the authorized MCP credential. The API derives channel/actor; MCP cannot override them. Agent identity remains per-invocation when supplied, otherwise unknown. Do not infer it from prompt content, server name, managed target ID, User-Agent, or an OAuth registration display name. Validate malformed optional metadata explicitly without turning normal absence into failure.

## Scope guard

No scheduler, LLM calls, direct application database/provider access, Redis, business calculations, package/quarantine implementations, or production deployment. Persistent encrypted MCP OAuth state is the only intentional token-persistence deviation from the current browser/API model.

## Validation

- Run `python -m pytest mcp/tests/test_auth.py mcp/tests/test_config.py mcp/tests/test_api_client.py mcp/tests/test_oauth_storage.py` using the documented project environment.
- Test discovery, protocol initialization, callback/PKCE protections, invalid/mixed/changed credentials, missing keys, refresh/revocation, encrypted persistence/restart, and correct token audiences. Prove omitted tools fail direct `tools/call` while allowed diagnostics remain usable.
- Add `mcp/tests/test_action_origin.py` for supported authenticated client IDs, reported/missing names/agents, per-field evidence, concurrent connections/tool calls, metadata bounds/spoof attempts, and trace propagation to the same API route.
- Use fixture Entra/JWKS/API servers for deterministic behavior; separately attempt real Entra/Graph/Power Platform flows only under approved accounts. Mark real proof unavailable when credentials are absent.
- Run configured Python type/static checks, the 03 API auth selector, and `git diff --check`.
- Install only after the new manifest/lock exists, using the approved Python feed; reject public extra indexes/direct resolution before any subprocess/container access.

## Production continuation

Apply README's Always-Deploy contract within explicitly authorized Part 2. The mandatory Part 1 user-acceptance gate cannot be bypassed as a residual test gap. Preserve OAuth security and API audiences; carry live gaps to 09/12 with containment/canaries. No fake discovery proof or implicit authorization for new production resources. Material API/web contract changes follow README's revalidation/reacceptance rule.

## Completion record

Write `completions/05-fastmcp-service-and-auth.md`: package versions/lock/feed, configuration names, supported upstream-token/OBO/client-context APIs, canonical routes, attribution source/evidence/bounds and unsupported-client behavior, persistence/lifecycle/rotation, protocol evidence, exact tests, root impacts, and 06/08/10 requirements.

## Done and handoff

An authenticated MCP client can invoke the diagnostic tool against the API under its verified user without a portal login. OAuth restart/refresh and credential failures are explicit. Business tools can build on one shared typed API adapter.
