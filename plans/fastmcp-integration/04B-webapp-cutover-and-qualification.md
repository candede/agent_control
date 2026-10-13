# 04B - Complete web cutover and regression qualification

## Mission

Finish and verify every existing web feature's exclusive use of canonical API operations. Qualify a deployable API/web revision without MCP, with a complete regression map rather than checks limited to the originally requested agent queries.

## Prerequisites

Read [README](README.md), [01](01-contracts-and-feasibility.md), [03](03-api-auth-integration.md), [03A](03A-shared-api-and-audit-origin.md), [04](04-api-read-contracts.md), [04A](04A-api-agent-controls.md), and their exact completion records; also inspect 02's foundation record. Reconcile the complete operation map, scoped status, current code, and worker instructions.

## Read first

- [Route registration](../../backend/src/app.ts), [route policies](../../backend/src/routes/policy.ts), [frontend app](../../frontend/src/App.tsx), [routing](../../frontend/src/workbenchRouting.ts).
- [HTTP adapters](../../frontend/src/api/client.ts), [report adapters](../../frontend/src/api/reportData.ts), [inventory queries](../../frontend/src/agentInventoryQueries.ts), [saved queries](../../frontend/src/savedQueries.ts).
- [Root runners](../../package.json), [frontend runners](../../frontend/package.json), [browser smoke](../../scripts/browser-smoke.mjs), [permission browser harness](../../scripts/permission-browser.tests.ps1), [local checks](../../deploy-local.ps1).
- API/frontend operation, parity, origin and control fixtures from 01-04A; all currently registered backend route modules and affected frontend pages/hooks/export adapters.

## Required implementation

1. Enumerate every current web page/action and HTTP operation, not just agents/users/champions. Cover sign-in/out and role/permission UX; inventory/search/filter/detail/About/configuration; people/access/package operations; Studio controls; adoption/usage/history; official report upload/manage/download/export; sync/enrichment/history; Purview/Defender investigations; audit; job polling/cancel/resume/reconcile; errors/partial/stale/authorization-wait states. Record each actual existing feature, canonical method/route, consumer, backend authority, transport policy, and regression proof. Do not invent absent features.
2. Close missing API/web wiring in the owning 03/03A/04/04A modules, updating their records. All frontend adapters/hooks/components must use the selected canonical operation for their business action. Keep authentication/static/download protocol boundaries explicitly classified; not every route is an MCP-exposed operation.
3. Remove replaced route registrations and obsolete frontend consumers only where a replacement was actually needed; retain working canonical endpoints. No alias fallbacks, double provider dispatch, dual business writers, MCP SDK, MCP URL, or separate web-only business calculations duplicating API authority. UI formatting and presentational state remain frontend responsibilities.
4. Preserve baseline business semantics, source selections, filters/defaults, cache/cursor identities, permissions/private scopes, confirmation, provider effects and job outcomes. Requested audit Origin fields are additive. No unapproved feature removal, new pages, control reinterpretation, automatic refresh, or broadened bearer access.
5. Extend API/frontend adapter and browser regression fixtures to cover the entire map. Assert actual HTTP methods/routes and registered handlers, not only service mocks; fail coverage when a feature is unmapped, a migrated action uses an obsolete route, or a consumer bypasses canonical authority.
6. Prove API browser/bearer parity directly with synthetic HTTP/JWKS/provider fixtures, including Viewer/Admin/native/guest denial and saved-data scope. A web manual test cannot prove bearer isolation, OBO, or claims/restart behavior; deterministic API checks are mandatory attempts before release. Keep unavailable live MCP proof for Part 2 without instantiating MCP.
7. Run targeted defects first, then existing aggregate backend/frontend regressions, builds/typechecks/lint, isolated DB/schema upgrade/recovery, relevant browser and fixed-bound capacity checks. Repair reproducible regressions at their root; preserve every exact failed/skipped/unavailable outcome with scoped containment.
8. Package a content-pinned API/web artifact and qualification receipt, with route/schema/DTO versions, complete feature coverage, baseline comparisons, test counts/results, upgrade/checkpoint requirements, residual owners/telemetry/triggers, and the manual test checklist for 04C. No MCP image or Python installation.

## Scope guard

No MCP implementation/resource provisioning, wholesale endpoint renaming, global business redesign, hidden compatibility path, intentional existing web behavior change, production deployment in this phase, live customer mutation, or fabricated full-app proof.

## Validation

- Run directly changed API/frontend selectors together before aggregate checks. Use `npm run typecheck --workspace backend`, `npm run typecheck --workspace frontend`, `npm run build`, `npm run lint`, and the documented isolated backend test path.
- Run `npm run test --workspace frontend` and the existing browser/permission harnesses where available. Report actual test/case/skip counts, not just exit codes.
- Attempt `pwsh ./deploy-local.ps1 check` and existing fresh-installation/persistence/restart/schema-upgrade tests in explicitly isolated projects. Prove the complete web/API runtime is healthy with no MCP service/configuration/process.
- Check the feature-to-canonical-route matrix against registration/HTTP capture and existing frontend actions; verify pagination/full descriptions, provider-free saved reads, uploads/exports, explicit controls, job recovery, audit Origin/filter/CSV, and error UX.
- Run link/receipt/redaction checks and `git diff --check`; obey README feeds. Do not install Python tooling in Part 1.

## Production continuation

Apply README's Always-Deploy and two-part contracts. 04C deploys this exact API/web artifact, observes it live, and hands it to the user; 12 is not the first opportunity to discover web regressions. Residual evidence remains truthful and narrowly contained, never a justification to skip the complete feature map or bring MCP forward.

## Completion record

Write `completions/04B-webapp-cutover-and-qualification.md`: complete web operation/consumer/proof matrix, removed obsolete routes versus retained canonical routes, baseline behavior evidence, content/schema/DTO hashes, exact check counts/results, root repairs, upgrade/recovery requirements, residuals, and executable 04C release/manual-test handoff.

## Done and handoff

Every current web feature has a canonical API authority and checked consumer path; no old/new business path remains. The API/web revision is packaged and truthfully qualified without MCP, ready for its independent production release.
