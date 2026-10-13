# 02 - Dormant API identity and credential foundation

## Mission

Implement tested bearer-validation, verified principal mapping, and delegated credential primitives without activating them on production routes. Existing browser authentication remains the only active entry path until 03.

## Prerequisites

Read [README](README.md), [01](01-contracts-and-feasibility.md), and `completions/01-contracts-and-feasibility.md`. Honor frozen interfaces and inspect scoped status. Resolve repository/worker instructions; preserve all current changes.

## Read first

- [MSAL](../../backend/src/auth/msal.ts), [auth flows](../../backend/src/auth/flows.ts), [configuration](../../backend/src/config.ts), [session types](../../backend/src/types/session.ts).
- [Session fences](../../backend/src/db/sessions.ts), [selection identity](../../backend/src/services/reportIdentity.ts), [capabilities](../../backend/src/services/capabilities.ts), [capability definitions](../../backend/src/services/capabilityRegistry.ts).
- [Authentication tests](../../backend/src/middleware/auth.test.ts), [HTTP authentication tests](../../backend/src/routes/authHttp.test.ts), [Entra roles](../../infra/entra-app-manifest.json), [security model](../../docs/security-model.md).
- The contract document and fixture outputs created in 01.

## Required implementation

1. Implement the single verified principal type and browser/bearer credential-source contract frozen in 01. Include tenant/application binding, proven principal key, app/provider role evidence, authorization freshness/epochs, and cancellation/revocation assertions. Retain validated authentication transport and application-client evidence so 03A can derive origin without trusting headers. Do not broaden existing private scope or implement the later audit writer/schema here.
2. Validate Entra access tokens using a maintained supported verifier: signature/JWKS, fixed issuer, configured tenant/audience, expiry/not-before, delegated scope, authorized MCP client, and required identity claims. ID tokens, application-only tokens, unknown tenants, malformed claims, key confusion, and wrong audiences fail explicitly.
3. Bound JWKS fetching/cache refresh and token exchange. Honor cancellation, throttling, claim challenges, and deadlines. Do not accept stale keys indefinitely or log tokens.
4. Implement audience-specific OBO acquisition and bearer-user revalidation without browser-cache dependence. Keep API provider/MSAL state ephemeral and keyed by verified tenant/principal/credential provenance. Never allow one account's grant to supply another's operation.
5. Provide a bounded credential context usable by asynchronous work after the originating request ends. Durable job records contain only non-secret provenance/references; expiry/revocation/restart requires fresh same-principal authority. Do not serialize assertions or provider tokens.
6. Preserve browser credential acquisition and role validation through the common interface. Plan account-wide versus connection-specific invalidation explicitly: portal logout/revocation follows existing account fences, MCP disconnect deletes its OAuth connection, and revoked API authority cannot resurrect through another transport. Define bounded role revalidation and actual Entra token/claims-challenge revocation timing; do not assert immediate external revocation from cached claims.
7. Add tenant integration configuration validation and non-secret registration/scope examples. Unknown/conflicting fields fail explicitly; no real credentials or public directory data in examples. Require admin-managed consent rather than new runtime consent or app-only grants. Define omitted future MCP integration as explicitly disabled bearer admission, not a browser startup failure or permissive default client; no MCP runtime/configuration is required for Part 1.
8. Use no database schema change unless a durable non-secret identity/lifecycle requirement actually needs it. If needed, own immutable migrations, fresh-init parity, schema fingerprint, retention, and bounded upgrade tests here.
9. Add focused synthetic tests for identity parity, guests, role evidence, competing grants, stale epochs, refresh/claims challenges, restart, and redaction. Update the contract/security/setup docs.

## Scope guard

Do not register bearer middleware/routes, change existing handlers, expose a feature flag, start provider work, persist API token caches, or introduce a second principal writer. Foundation code is dormant, not a partially active compatibility path.

## Validation

- Create focused tests such as `src/auth/mcpBearer.test.ts`, `src/auth/requestPrincipal.test.ts`, and `src/auth/delegatedCredentials.test.ts`.
- Run them together: `npm run test --workspace backend -- src/auth/mcpBearer.test.ts src/auth/requestPrincipal.test.ts src/auth/delegatedCredentials.test.ts`.
- Run `npm run typecheck --workspace backend` and the existing MSAL/config/session suites affected by the change. Use existing isolated database tooling for any database-backed tests.
- Prove no new route registration or provider dispatch and run `git diff --check`. Follow README feeds; do not install without a manifest change or missing dependency.

## Production continuation

Apply README's Always-Deploy and two-part contracts. Record unavailable live consent/OBO evidence with exact affected scope and later 12 canaries; keep unsupported or unproven token admission closed. Foundation remains dormant until complete 03 integration. 04C later deploys the API/web revision without MCP; user acceptance precedes any Part 2 work.

## Completion record

Write `completions/02-api-auth-foundation.md` with interfaces, token validation rules, principal mapping proof, credential/revocation lifecycle, configuration/migrations, focused results, root impacts, residuals, and exact consumers for 03.

## Done and handoff

03 can activate one shared authentication/credential authority across requests, services, and jobs without constructing fake sessions, requiring a portal login, or changing saved-data identities. Browser runtime remains unchanged at this phase boundary.
