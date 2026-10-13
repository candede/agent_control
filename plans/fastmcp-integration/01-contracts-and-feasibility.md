# 01 - Contracts and feasibility

## Mission

Freeze the complete API/web operation map and the later audience-correct MCP integration contract from current code and primary SDK/protocol sources. Map every current web feature and requested query/control to its API authority and proof. Implement contract artifacts and bounded feasibility fixtures, not the later MCP service.

## Prerequisites

Read [README](README.md), current repository instructions, and the applicable implement-folder worker contract. Inspect current status and baseline; preserve unrelated changes. No earlier completion record is required.

## Read first

- [API registration and browser boundaries](../../backend/src/app.ts), [route policies](../../backend/src/routes/policy.ts), [authentication](../../backend/src/middleware/auth.ts), [MSAL](../../backend/src/auth/msal.ts), [session identities](../../backend/src/types/session.ts), [selection identity](../../backend/src/services/reportIdentity.ts).
- [Inventory reads](../../backend/src/routes/inventoryData.ts), [official reports](../../backend/src/routes/officialReportData.ts), [adoption](../../backend/src/services/adoptionGroups.ts), [package controls](../../backend/src/routes/inventoryMutations.ts), [quarantine](../../backend/src/routes/copilotStudioQuarantine.ts).
- [Security](../../docs/security-model.md), [report interpretation](../../docs/official-usage-import.md), [Compose](../../compose.yaml), [Azure topology](../../infra/main.bicep).
- Verify dated primary documentation for FastMCP AzureProvider/OAuthProxy upstream token access, signing/storage, MCP authorization/Streamable HTTP, Entra OBO, and each target client. Never send repository code to web research services.

## Required implementation

1. Create `docs/mcp-integration.md` as the shared implemented-contract document: exact canonical HTTP method/route/query/body/defaults for every current web feature and matching future MCP tool, request principal, tenant binding, registration/scopes/consent, token audiences, credential lifetimes, data/error envelopes, exact-control routing, operational bounds, and client-versus-server confirmation ownership. Each shared operation has one API route, not MCP-specific mirrors; web does not call MCP. Reuse sufficient existing endpoints, identify only necessary replacements, and classify browser-only/authentication/upload/download boundaries without broadening the MCP allowlist.
2. Resolve the principal-mapping and guest-account hypotheses against MSAL semantics and current database keys. Record how API-audience access-token claims establish the same saved-data principal without assuming a browser account cache or constructing `homeAccountId` from guessed fields.
3. Freeze the separate MCP/API registration flow. Verify a supported way to access the proxy's upstream Entra assertion; a FastMCP-issued client JWT is not that assertion. Specify API-to-Graph and API-to-Power-Platform delegation, app-role freshness, provider-role evidence, claims challenges, and required admin-managed consent.
4. Define the dormant/activation boundary for 02/03: one principal and credential interface, one route-policy authorization mechanism, all service/worker consumers, revocation fences, and provider-free saved reads. Do not make a global CSRF/Origin exception.
5. Map inventory scopes, descriptions/configuration sections, creator versus owner versus usage, exact UPN resolution, user/license/service-plan facts, company/department cohorts, champions-only associations, report-only rows, history, audit/hunting, refresh, and controls. Identify narrowly missing API joins/projections for 04; never plan MCP-owned business calculations.
6. Define stable v1 input/output/error shapes and units. Reuse existing selection/cursor identities and limits. Specify behavior for partial sources, unknown dates/descriptions, oversized full text, unsupported targets, duplicate names, expired receipts, and incompatible trend windows. Freeze the current `createdWithinDays` cutoff semantics at one selection evaluation time; boundary tests must distinguish true creation from modification, collection, or import time.
7. Create minimal synthetic feasibility/contract fixtures under the existing backend test conventions where executable checks are possible without the later Python dependency manifest. Record primary-source-only claims as unverified until 05/09/12; do not label a mocked OBO exchange live proof.
8. Document all new configuration names, secret owners, route/tool allowlist, API-only provider credentials, MCP-only encrypted persistent OAuth state, and the single-instance Azure mount requirement. The 05 server tool allowlist must deny direct invocation of omitted tools; client-side hiding is not containment. Add links from the appropriate current setup/security documentation.
9. Update this roadmap if a verified SDK constraint disproves its proposed token flow. Choose one supported design, update all consumers, and record the decision; no alternative dormant implementations.
10. Freeze 03A's first-class audit-origin v1 descriptor and transport contract: server-derived channel, verified integration application, available client/calling-agent IDs/names/version with per-field evidence, and safe trace IDs. Determine the supported FastMCP sources for authenticated client identity versus reported `clientInfo`/namespaced request context; if a client supplies no agent identity, record unknown. Never equate the caller with the managed target or treat a reported label as verified.
11. Map current append/projection/direct-SQL/quarantine audit stores, originating job/stage context, frontend list/details/filter/CSV consumers, exact schema upgrade path, and historical unknown semantics. Freeze lifecycle rules for preview versus execution provenance, restart, idempotent replay, and cross-client resume; 03A owns implementation and 05 owns actual protocol collection.
12. Freeze Part 1 baseline behavior and feature/route coverage from current web consumers, including reports/import/export, permissions, access/package actions, refresh/investigations and job recovery. Assign API/web controls to 04A, exhaustive consumer cutover/qualification to 04B, and the independent no-MCP production release/manual-test handoff to 04C. Record the actual accepted-revision/start-Part-2 prerequisite for 05; a deployment receipt is not user acceptance. No API routing or frontend cutover requirement may have its first implementation owner in Part 2.

## Scope guard

No application scheduler, business approval policy, generic API proxy, new classification service, production target inference, or dependency installation solely for research. No live deployment, tenant setup changes, or provider writes.

## Validation

- Validate documented route names, capability IDs, principal fields, and SDK claims against controlling code/sources. Capture all current frontend route usage and require the same canonical route for each matching MCP tool; assign missing read/control consumer work to 04/04A and completeness checks to 04B.
- Run new backend contract fixtures with one targeted Vitest selector, then backend typecheck if code/types changed. Documentation-only artifacts need link/diff checks, not a full build.
- Check requirement-to-phase/proof ownership, phase prerequisites, local links, and `git diff --check`.
- Follow README feeds for every dependency subprocess; install only after manifest changes or missing-tool failure.

## Production continuation

Apply README's Always-Deploy and two-part contracts. 04C releases API/web without MCP and pauses for user manual acceptance; 12 owns later live MCP proof. Live Entra/client unavailability is recorded honestly with affected scope, containment, production canary, owner, and fix-forward trigger; continue implementable work. It never licenses speculative token acceptance, early MCP implementation, or production actions without an approved target.

## Completion record

Write `completions/01-contracts-and-feasibility.md`: fixed contracts, API/tool map, dated sources, falsified/remaining hypotheses, configuration names, root impact, exact attempted checks/results, and external evidence gaps. Do not invent deployment or client evidence.

## Done and handoff

02 receives exact principal/credential interfaces and dormant boundaries. 03A receives the origin schema/trust/lifecycle/upgrade and parity contract; 04/04A receive read/control contracts and web consumers; 04B receives the complete baseline feature map; 04C receives the independent release/manual acceptance contract. After actual acceptance, 05 receives the supported SDK/token/storage/attribution contract; 09 receives client-specific evaluation obligations; 10 receives later MCP infrastructure requirements. All behaviors have Part 1 or Part 2 implementation and production-proof owners.
