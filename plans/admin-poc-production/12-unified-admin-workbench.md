# Phase 12 - Unified Admin Workbench, Reporting, and Export

## Mission

Converge all implemented sources into a coherent administration workbench that supports inventory, identity review, official usage, package controls, quarantine, audit, Defender investigations, transcripts, permissions, and source-safe export without hiding unavailable capabilities.

## Prerequisites

- Read the roadmap and all completion records for Phases 01-11.
- Every provider must expose normalized read models, capability requirements, freshness, lineage, and role enforcement even when its live probe is unavailable.
- Do not deploy in this phase.

## Read first

- Entire `frontend/src` application and tests
- Backend routes/types introduced in Phases 01-11
- Existing `App.tsx`, `App.css`, `index.css`, API client, agent/user/report/audit components
- Phase 03 Permission Center and shared capability gates
- All provider completion records and residuals

## Required implementation

1. Replace the current monolithic view switching with a responsive application shell and routeable views for **Overview**, **Agents**, **Power Platform inventory**, **Users**, **Official usage**, **Audit**, **Security**, **Transcripts**, and **Permissions**. Preserve deep links, filters, selections, and browser navigation.
2. Make **Agents** the primary normalized workbench. Provide server-side search/filter/sort/paging, saved column sets, bulk selection, freshness, and columns for type/authoring source, owner, environment, publish/lifecycle, official usage, package access/block, quarantine, Defender risk/activity, transcript availability, and identity confidence.
3. Build a source-aware agent detail workspace with unframed tabs for Overview, Identities, Package, Power Platform, Official usage, Audit, Security, Transcripts, and Controls. Every field shows provenance and observation time; disagreements are displayed, never silently resolved by source priority.
4. Add an identity-review queue for ambiguous/unmatched links with side-by-side source IDs/evidence, manual link/unlink, revision fencing, confirmation, audit, and rebuild preview. Names may help a human search but never auto-link.
5. Preserve the full Power Platform inventory explorer for apps, flows, connectors, environments, and groups, not just agents. Show role-scoped coverage, preview connector details, truncation, nulls, sovereign limitations, and source freshness.
6. Preserve the current Agent/User reporting outcomes and enrich them with durable report-set lineage, official-source labels, unresolved identities, period consistency, and source comparisons. Report counts never borrow from audit, hunting, or transcripts.
7. Build one audit workspace with tabs/filters for local administrative audit, Graph Purview searches, and continuous Management Activity records. Provide a combined read projection only when identical provider event IDs are deduplicated, while retaining source/query/ingestion lineage.
8. Build a security workspace for `AgentsInfo`, Agent 365 activity, curated investigations, source coverage, and readiness diagnostics. Keep advanced KQL configuration/role gating intact.
9. Build transcript metadata/redacted views and raw reveal flow exactly as Phase 11 specifies. Never preload/decrypt raw content for list rows or counts.
10. Centralize action policy. Each package/quarantine/import/search/collector/transcript action declares internal role, capability ID, target source ID, preview/stability, confirmation, and server route. Rendering and server checks consume the same typed metadata.
11. Add an operational Overview for permission health, inventory coverage, stale providers, official report freshness, collector lag/gaps, failed/partial jobs, identity conflicts, security signals, quarantine/package restrictions, transcript retention, and production health. It is an admin surface, not a marketing hero.
12. Add source-safe exports for normalized inventory, Power Platform inventory, official usage, audit metadata, security results, and redacted transcript analytics. Export requests are server-side, bounded, formula-injection-safe, role/capability gated, revision-stamped, content-typed, and audited. Raw transcript export remains separately disabled by default.
13. Add job/activity center for imports, refreshes, searches, collection, exports, bulk mutations, retention, and backups. Show durable state, progress, partial results, cancellation, retry eligibility, actor, target, timestamps, and correlation ID.
14. Replace ad hoc API calls with a typed client/error layer supporting abort, request IDs, consistent pagination, `problem+json`, auth expiry, capability refresh, and safe retry prompts. Do not retry mutations automatically.
15. Introduce Playwright browser coverage for core paths at desktop and mobile widths. Add stable synthetic seed/reset commands that cannot run against production unless an isolated qualification namespace and explicit acknowledgement are supplied.
16. Meet WCAG 2.2 AA fundamentals: landmarks, headings, labels, descriptions, table/grid semantics, keyboard action menus, focus restoration, reduced motion, live job status, contrast, zoom/reflow, and no color-only state. Long permission/source identifiers must wrap without overlap.
17. Keep the interface dense and operational: no nested cards, oversized hero text, decorative gradients/orbs, or explanatory feature marketing. Use existing Lucide icons, restrained status language, and tooltips for unfamiliar icon actions.

## Focused validation

- Component/route tests for every view, deep link, capability state, provenance/disagreement, loading/empty/error/stale/partial state, and internal role persona.
- Playwright paths for reader, operator, security reader, transcript reader, administrator, and deliberately underprivileged users using synthetic capability fixtures.
- Mutation UI tests proving exact target/source, confirmation, conflict, partial result, verification, and no accidental double submit.
- Export tests for role/capability/retention, paging, snapshots, CSV injection, redaction, audit, cancellation, and large bounded data.
- Automated accessibility plus keyboard/zoom/reduced-motion tests; responsive screenshots at mobile and desktop with no tenant data.

## Aggregate validation

Run the global validation baseline and the new Playwright suite. Seed a synthetic multi-source dataset, exercise all views/actions with provider mutations mocked, export every allowed dataset, reset it, and prove no plaintext sensitive content remains.

## Production continuation

UI or browser residuals do not stop the campaign. Disable only affected action/content surfaces, preserve server enforcement, and carry screenshot/test evidence, viewport, owner, and trigger. Never hide a missing capability to make an overview appear healthy.

## Scope guard

Do not add provider operations, permissions, or authority rules not implemented in Phases 01-11. Do not deploy. Do not introduce browser-local production state.

## Completion record

Create `plans/admin-poc-production/completions/12-unified-admin-workbench.md` with view/action/export coverage, persona/accessibility/browser evidence, screenshots containing synthetic data only, and Phase 13 preconditions.

## Done conditions

- Every researched provider capability is reachable or visibly disabled with exact requirements.
- Agents, identities, sources, controls, reports, audits, security, transcripts, permissions, jobs, and exports form one coherent operator workflow.
- Provenance and authority boundaries remain visible in all combined views.
- Core workflows pass synthetic desktop/mobile browser and accessibility validation.
