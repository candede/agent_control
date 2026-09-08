# Phase 10 - Unified Workbench and Single-App Delivery

## Mission

Integrate the retained features into a dense operational workbench and extend proof of Phase 01's combined Express/React package for local Docker and Azure delivery. Do not add a second packaging authority, removed features or an operations platform.

## Prerequisites

- Follow the README's fresh-session contract. Read Phase 09's completion and relevant owner artifacts from Phases 02-08, including linked unresolved issues.
- Provider read models, role/data scope, freshness and actions exist even where live eligibility is unavailable. Reuse Phase 01's Docker/local script/ZIP export and Phase 03's containerized capability/accessibility/browser harness.
- No Azure deployment in this phase; run local Docker validation and deliver the packaged app to Phase 12.

## Read first

- `frontend/src/App.tsx`, `App.css`, `index.css`, API client and implicated agent/report/audit components/tests
- Delivered provider types/routes/action policies and Phase 03 shared gates
- `backend/src/server.ts`, auth/configuration and root/workspace build scripts
- `frontend/vite.config.ts`, frontend public routing configuration and existing deployment packaging references

## Required implementation

1. Provide routable **Agents**, **Power Platform inventory**, **Users**, **Official usage**, **Audit**, **Security**, **Permissions** and a small **Jobs** view. Agents is the first screen, not a marketing/health dashboard. Preserve deep links, filters, selection and browser navigation; do not add transcript or identity-review navigation.
2. Integrate bounded server-side inventory search/filter/sort/paging and existing bulk controls. Display authoring/type, owner/environment, lifecycle, official usage and authorized provider restrictions/risk with provenance and freshness. Omit inaccessible fields before counts/joins. Unmatched records remain separately listed, not sent to a review queue.
3. Use source-aware detail tabs for identities, package/Power Platform data, reports, audit/security and controls as authorized. Show exact identifiers, observation times and disagreement without synthesizing a provider state or permitting manual links. Keep the broader Power Platform explorer within the existing inventory UI.
4. Preserve aggregate/user reporting outcomes and the three-file import workflow: lineage, period, active/superseded/incomplete/stale states and unresolved rows. User-level report data needs `SecurityReader`; an administrator's import preview is limited to their submitted data. No cross-source metric substitution.
5. Build the audit workspace from exactly two sources: local administrative audit and on-demand Graph Purview search. Keep their labels, filtering and totals separate; scope delegated results before aggregation. No continuous feed, subscriptions or collector status.
6. Integrate Phase 08's fixed-template Defender investigations, actual scope, partial coverage, preview/readiness and external portal link. No arbitrary KQL, raw response inspector or content viewer.
7. Centralize the existing typed action metadata: app role, capability, native target, preview, confirmation and route. Preserve backend enforcement. Use explicit refresh/search actions; navigation may load saved backend data and poll a submitted job but never starts recurring provider work.
8. Implement bounded server-side exports of authorized inventory, official report and allowlisted investigation fields. Stamp source/window/snapshot selection; protect CSV formulas, content type and filenames. Recheck current role, actor/dataset scope and source validity at download. Audit without rows; no public/bearer-only URLs. Cached exports do not require live provider availability.
9. Prefer direct bounded streaming exports; use existing durable jobs only where size requires it. Temporary artifacts have finite expiry and cleanup on failure/restart, source deletion and scope revocation; pending work cannot publish after invalidation. Keep retrieval within finite row/byte/time limits. No raw provider/CSV archive or external artifact platform.
10. Show only user-facing job progress for imports, refresh/searches, exports and bulk actions: actor/target, status, partial result, cancellation and valid retry/reauthorization. An uncertain write offers reconciliation, not replay. Operational users receive safe status/correlation metadata, not unrestricted result bodies. Backups, retention and recovery stay documented operator commands, not UI actions.
11. Reuse the typed client/error layer for abort, pagination, `problem+json`, request IDs, auth expiry and safe retry prompts. Never retry mutations automatically or leak saved results after logout/role loss.
12. Extend Phase 01's reproducible single-app build/start/package contract and its routing tests for all new views. Built React assets remain in the deployable Express image/ZIP, with legitimate SPA deep links. API/auth/health routes take precedence; unknown `/api` and missing assets return correct errors, not HTML. Protect path traversal; apply CSP, safe asset caching and no-store for authenticated APIs/sensitive pages. Static shell assets may be public but carry no user data; all API data remains authenticated.
13. Verify no frontend runtime depends on SWA headers, API proxy or a separate origin. Both deployment workflows use built assets; no host Vite process is required. Express/MSAL owns auth and rejects client-supplied identity headers. Update the existing output/start/environment contract for Phase 12, including canonical callback/cookie/origin and containerized package smoke. Recheck the Azure-target Linux ZIP architecture/runtime, production dependency closure and image/ZIP parity from the same build; do not introduce a custom-image registry or parallel cloud build pipeline.
14. Extend existing component/Playwright/axe coverage using local fixture transports and isolated test databases. Production builds cannot enable fixture/auth-bypass modes. Phase 13 uses approved canary targets and temporary report datasets, not a mandatory persisted synthetic namespace framework in every table.
15. Keep the existing restrained visual language and Lucide icons. Test WCAG 2.2 AA fundamentals, keyboard/focus, landmarks, tables, live job status, contrast, reduced motion, zoom/reflow and long identifiers. No nested cards, oversized heroes or explanatory feature marketing.

## Focused validation

- View/deep-link and four-role personas, underprivileged access, source disagreement, stale/partial/empty/error states and absent deferred navigation.
- Exact-target confirmations, no double-submit/replay, bounded jobs, reauthentication and source-safe combined counts/exports.
- Export expiry/revocation/deletion races, formula injection, bounded streaming, temporary-file cleanup and redacted logs.
- Packaged Express app: asset/deep-link success, API/auth precedence, API 404, missing asset 404, CSP/caching, traversal rejection, exact same-origin callback and no trusted spoofed identity headers.
- Browser tests against the built artifact, not only Vite: desktop/mobile screenshots with synthetic data, keyboard/zoom/focus and axe checks. Fixture configuration rejected in production.

## Aggregate validation

Run the README baseline, containerized browser/accessibility suite and packaged-app smoke command. Exercise retained workflows and exports with local deterministic provider fixtures in isolated databases, then delete test data and temporary artifacts. Rerun `deploy-local.ps1` to verify the two-container topology, origin and preserved data still hold. Record exact Docker build/test/export/smoke commands for Phases 11-13; no host app toolchain is required.

## Production continuation

Carry honest browser/provider residuals with affected scope and evidence. Fix reproducible core auth/routing defects before this phase completes; unavailable retained providers may stay disabled. Future features are absent, not unavailable capabilities.

## Scope guard

No new provider operations/permissions, transcript/feed/identity-review scaffolding, maintenance UI or cloud changes. Do not reintroduce browser-local report authority or independent frontend deployment.

## Completion record

Create `plans/admin-poc-production/completions/10-unified-admin-workbench.md` with delivered views/action/export contracts, single-artifact output/start paths, actual UI/security tests, linked issues and Phase 11 preconditions. Screenshots contain synthetic data only.

## Done conditions

- Retained features form one source-safe operator workflow; removed features have no controls or placeholders.
- Exports/jobs enforce current data scope and finite lifecycle; maintenance remains command-driven.
- One Express-served React artifact has focused routing/auth and desktop/mobile browser proof for production packaging.
