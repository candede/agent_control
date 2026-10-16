# 05 - FastMCP service and Entra authentication

## Mission and inputs

Implement the future Python FastMCP service, authenticated Streamable HTTP,
encrypted connection storage and typed API client. Read the [roadmap](README.md),
[current API/authentication contract](../../docs/mcp-integration.md),
[security](../../docs/security-model.md) and
[configuration](../../docs/deployment-setup.md). Inspect current API source and
supported pinned SDK contracts; historical completion/acceptance records are
not prerequisites. This plan is not evidence that MCP exists.

## Implementation

1. Create `mcp/` with `pyproject.toml`, reproducible pinned lock, service/config/
   auth/API-client modules and focused tests. Use maintained SDK OAuth and
   encryption support, not custom cryptography.
2. Configure exact tenant-specific OAuth/discovery, resource/callback URLs,
   PKCE and redirect/consent protections. Validate configuration before readiness;
   reject caller-selected tenants/origins and permissive callback wildcards.
3. Recover the verified upstream Entra credential using supported pinned SDK
   APIs and obtain an API-audience delegated token. Never use the proxy-issued
   client JWT, ID token or cross-audience passthrough as the API assertion.
4. Persist only MCP OAuth connection material in encrypted, access-restricted
   file storage with independent signing/encryption keys. Define disk/retention,
   restart, revocation, key rotation and reconnect behavior. API provider
   credentials remain ephemeral; MCP has no application database credentials.
5. Bind token exchanges and credentials to exact request/principal/audience.
   Handle expiry, claims challenges, throttling, cancellation and bounded retries
   without account crossover or blocking async work.
6. Implement typed allowlisted canonical API methods/routes, finite request and
   response bounds, source/cursor preservation, safe errors and correlation.
   No arbitrary HTTP tool, provider access, domain joins/calculations or
   empty-success fallback.
7. Add safe health/readiness and authenticated diagnostic metadata. Every
   protocol request validates credentials; a session ID is not authorization.
8. Capture request-local authenticated client identity separately from reported
   client/agent labels through supported SDK metadata. Forward only the API's
   bounded attribution descriptor; never infer agent identity from prompts,
   managed target IDs or a connection's last caller.
9. Document actual config/test/OAuth setup and supported SDK APIs. Missing optional
   labels stay unknown. The configured supported catalog must be usable without
   a release-approval file or extra runtime feature-enable ceremony.

## Verification and handoff

Add focused auth/config/API-client/OAuth-storage/origin tests, including protocol
initialization/discovery, PKCE, wrong/mixed credentials, missing keys, encryption,
restart/refresh/revocation, audience and concurrent-caller attribution. Use
synthetic Entra/JWKS/API fixtures, then configured Python static/type checks and
affected existing API tests. Live native/guest consent is separate evidence.

Install only after the new manifest/lock exists and only through
[approved feeds](README.md#feeds-and-execution). No deployment, scheduler, LLM,
business tools, Redis or second application-data store in this phase.
Update current setup/security/contracts with implemented facts and exact test
results; [06](06-mcp-read-tools.md) consumes the shared authenticated adapter.
