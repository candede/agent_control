# 04 - Complete API read and analysis contracts

## Mission

Complete narrowly missing shared API queries/projections and current web read consumers before the first API/web release, so later MCP tools answer the agreed questions without client-side business joins or invented evidence.

## Prerequisites

Read [README](README.md), [01](01-contracts-and-feasibility.md), [03](03-api-auth-integration.md), [03A](03A-shared-api-and-audit-origin.md), and their completion records. Use the frozen canonical web/MCP route map, active bearer principal, and origin/parity fixtures. Inspect current status and applicable instructions.

## Read first

- [Inventory reads](../../backend/src/routes/inventoryData.ts), [query engine](../../backend/src/db/inventoryQueries.ts), [presentation](../../backend/src/services/inventoryPresentation.ts), [responsibility types](../../backend/src/types/agentResponsibility.ts).
- [Reports](../../backend/src/routes/officialReportData.ts), [report types](../../backend/src/types/officialReportData.ts), [adoption calculation](../../backend/src/services/adoptionGroups.ts), [report SQL](../../backend/src/db/officialReportQueries.ts).
- [Detailed package fields](../../backend/src/types/copilotPackage.ts), [native metadata](../../backend/src/types/powerPlatformInventory.ts), [saved people](../../backend/src/services/savedAgentPeople.ts), [About UI](../../frontend/src/components/AgentOverview.tsx).
- [Report interpretation](../../docs/official-usage-import.md), [data foundation](../../docs/record-data-foundation.md), and existing inventory/report/adoption/people tests.

## Required implementation

1. Reuse existing endpoints wherever their contracts suffice. Add only missing API-side relationships, cohort projections, and exact detail/section access identified in 01. Use one canonical route/controller per operation for web and MCP, update matching frontend flows, and share current SQL/services/generation selections; no new agent/user/usage authority or MCP-only query defaults.
2. Provide exact username-to-authorized-user resolution with ambiguity, concealed/unresolved report identity, and missing-directory evidence. Never treat UPN as an invariant email identifier or match people/agents by display name.
3. Support user-agent relationships separately for usage, creation, ownership, and last modification. Preserve exact canonical/native/report identities and evidence; a creator query cannot return owned/used agents as creations. Preserve current user details, licensing/entitlement/service-plan facts, source availability, and company/department facets in the read map.
4. Return full available long/native/short About text with source, observation, and missing-field state. Reuse configuration-section APIs for saved tools/connectors/model/channels/knowledge metadata within existing authorization. If text exceeds the current envelope, provide explicit version-pinned continuation rather than silent truncation.
5. Support full authorized inventory, including Power Platform-only records, and report-only usage rows. Filters include existing platform/type/creation windows and exact user relationships. Unknown creation time remains unknown; missing metadata never proves absence. Test exact creation-window thresholds and pin relative-time evaluation to the selected query rather than advancing it between pages.
6. Reuse the portal's exact champion ranking. Implement champions-only used/created relationships with an API-owned SQL join/projection. The current group's agent list includes non-champions and organization-filtered relationships; do not substitute it for the requested champions' complete authorized agent usage.
7. Supply source-backed counts/grouping/history comparisons required by the tool map. Keep dates/windows/cohorts, report selection, non-additive categories, unresolved associations, concealed users, stale sources, and overlap constraints explicit. Do not derive daily response volumes from last-activity dates or sum overlapping imports.
8. Pin inventory/report/directory selections and join authority for paginated compound reads. Recheck epochs and source dependencies on every continuation; changed/reset/expired data cannot silently switch mid-query.
9. Keep summaries, counts, joins, and facets in SQL with bounded queries and existing limits. Avoid returning entire tenants, per-row Graph enrichment, MCP/browser-owned joins, or an N+1 description/relationship design.
10. Extend types, request validation, error/provenance contracts, exports/UI where corresponding existing consumers need shared-route parity. Keep current selected view/filter semantics explicit rather than forcing an MCP-only full-inventory default. Preserve 03A origin/evidence fields in audit reads and shared export actions. Own required indexes/upgrades with exact input/output fingerprint, grants and fresh-init parity; append to README's 03A-owned known-baseline chain for 04C instead of leaving a latest-schema-only upgrade. Add semantic fixtures and update the sole integration map/usage docs.

## Scope guard

No new data ingestion source, designated champion groups, persisted LLM taxonomy, fabricated usage/trend metrics, raw provider diagnostics, prompt instructions/transcripts absent from authorized saved APIs, or hidden provider work during reads.

## Validation

- Add a focused `src/routes/mcpReadContracts.test.ts` and use it with directly changed adoption/inventory/report/people suites.
- Prove more than one page, duplicated names, guest/private scopes, all platform/report-only cases, champion versus non-champion usage, full non-truncated text, unknown metadata, revision invalidation, and incomparable history.
- Run backend typecheck and SQL/index/schema checks where changed; use the existing isolated DB harness. Build/test frontend only when its contract consumers changed.
- Verify query count/work bounds for a large synthetic cohort; do not measure only a first-page proxy.
- Use 03A's direct browser/bearer HTTP parity harness for agent/user listing, relationships, descriptions, usage, audit filters, and errors under equal source/input/user; no running MCP is required. Test frontend adapters against the same canonical operation map later consumed by 06.
- Run local-link checks and `git diff --check`; obey README feeds.

## Production continuation

Apply README's Always-Deploy and two-part contracts. 04B qualifies web consumers and 04C first deploys API/web reads without MCP; 12 later proves MCP tools. Unsupported measurements are explicit limitations, not empty success. Carry inaccessible live datasets with dated scope/canary ownership; never widen source authorization or defer needed API/frontend implementation into Part 2.

## Completion record

Write `completions/04-api-read-contracts.md`: exact endpoints/shapes, reused/new SQL authority, index/migration effects, relationship/trend semantics, pagination/provenance proofs, current web consumers, root impacts, tests, residuals, 04A/04B/04C prerequisites, and later 06 adapter map.

## Done and handoff

04A/04B can complete controls and all-app qualification on final shared reads. Full descriptions, exact relationships, champions-only cohorts, aggregates, and honest history are API-provided, bounded, and source-backed; current web meanings are preserved. Only after the 04C release and actual acceptance can 06 wrap them as thin MCP tools.
