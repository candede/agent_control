# Phase 04 - Power Platform Inventory and Exact Identities

## Mission

Integrate the Power Platform Resource Query API through explicit bounded refreshes, enrich the agent workbench and associate sources only through exact documented identifiers. Unmatched data remains separately visible and usable.

## Prerequisites

- Follow the roadmap's manual fresh-session contract; read Phase 03's completion record, Phase 02's auth/data-scope contracts, and Phase 01's identity/job repository artifacts.
- Capability registry, incremental consent, durable on-demand jobs, scoped source identifiers and Permission Center must be operational. This phase owns allowlisted inventory snapshot/scan tables and exact-ID association helpers.
- Do not deploy to Azure in this phase; use Phase 01's Docker deployment/test commands locally.

## Read first

- Phase 01 normalized identity and provider job code
- Phase 02 capability definitions and token service
- Current package types in `backend/src/types/copilotPackage.ts` and `frontend/src/api/client.ts`
- `frontend/src/agentDisplay.ts` and tests
- [Power Platform inventory](https://learn.microsoft.com/en-us/power-platform/admin/power-platform-inventory)
- [Inventory API](https://learn.microsoft.com/en-us/power-platform/admin/inventory-api)
- [Inventory schema](https://learn.microsoft.com/en-us/power-platform/admin/inventory-schema)
- [Copilot Studio agent schema](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-agent-inventory)

## Permission contract

- API: `POST https://api.powerplatform.com/resourcequery/resources/query?api-version=2024-10-01`.
- Delegated permission: Power Platform API `ResourceQuery.Resources.Read`.
- Full inventory Entra roles: Global Administrator, Power Platform Administrator, Dynamics 365 Administrator, or Global Reader.
- AI-scoped inventory Entra roles: AI Administrator or AI Reader; these can see agents, agentic apps, agent flows, environments, and environment groups but not ordinary canvas/model-driven apps or cloud flows.
- Built-in Power Platform RBAC roles are explicitly not supported for inventory visibility.
- Implement delegated inventory only. No speculative app-only adapter, role grant or unattended inventory collector.

## Required implementation

1. Implement a typed Resource Query adapter with timeouts, bounded retries, `Top` plus `skipToken` pagination, response validation, throttling handling, and query-clause builders. Do not concatenate user-provided KQL expressions.
2. Ingest the inventory resource types supported by the current API: Copilot Studio/Agent Builder agents, agent flows/workflow agent flows, Power Apps resource types, Power Automate cloud flows, connectors, environments, and environment groups. Retain role-scoped omissions as `not_authorized_scope`, not as zero resources.
3. Provide an inventory explorer with server-side filtering, sorting, pagination, counts, source freshness, CSV export, and type-specific detail. It must demonstrate the API's available inventory while keeping the agent workbench primary.
4. For `microsoft.copilotstudio/agents`, retain allowlisted identity, authoring tool, bot/environment, lifecycle, quarantine, owner and authentication metadata needed by the workbench. Keep only documented bounded provider-specific detail fields with a concrete UI use; unknown fields are discarded with safe schema diagnostics. Do not retain raw responses or sharing/connection secrets. Other resource types share the explorer, not separate product workflows.
5. Preserve GA versus preview status per field. Display missing/null fields as not supplied, not false. Mark the 200-resources-per-type capability detail truncation and preserve total capability counts.
6. Retain typed package/app/manifest/asset, bot/environment, Entra app/agent and blueprint identifiers when supplied. Associate only exact identifiers under a documented relationship within tenant/environment scope. An identical GUID in different identifier kinds is not a match; a blueprint can have many children and is not an equivalence merge.
7. Publish a small exact-ID resolution helper with `resolved`, `unresolved` and `ambiguous` outcomes. Non-unique or undocumented matches stay separate, with a reason visible in detail. No conflict-review queue, manual link/unlink, merge/split API or relationship-history engine. Recompute associations from current allowed fields; never widen source visibility or change native mutation targets.
8. Replace `shortDescription` parsing as classification authority. Keep it only as a labeled package hint when no authoritative field exists. The normalized projection exposes `sourceSystem`, `authoringTool`, `creatorType`, `agentKind`, `lifecycle`, `identityConfidence`, and per-field provenance.
9. Provide explicit current-user refresh jobs using Phase 02's in-memory MSAL cache and `waiting_authorization` behavior after cache loss. No scheduled refresh or fetch-on-navigation loop. Retain scope (principal/role/environment/type/query), page completion, counts/truncation and last-success/attempt. Remove absent rows from the current snapshot only after complete enumeration of the same scope, never a partial/failed/narrower scan. Provider refresh latency informs freshness, not immediate deletion. Publish atomically after complete paging; failure preserves the prior snapshot and safe partial-attempt metadata. Apply finite snapshot/job retention and no general replay history.
10. Handle sovereign-cloud support differences, classic/V1 bot exclusion, unpublished configuration caveats, hidden workflow environments, conditional-access failures involving Azure Resource Manager, and preview connector inventory.

## Focused validation

- Adapter tests for pagination, empty/partial/truncated pages, schema drift, duplicate resources, throttling, malformed free-form properties, role-scoped omissions, and sovereign clouds.
- Identity tests for exact documented associations, ambiguous collisions, unmatched sources and deterministic projections.
- Test same GUID across tenants/kinds/environments, one blueprint with multiple children, narrower/partial scans without deletion and private delegated data in joined projections/counts/exports.
- Migration/repository tests for fresh/upgrade snapshots, finite retention, atomic publication, explicit refresh, restart reauthorization and unknown-field discard. Startup/navigation never submits a new provider scan.
- UI tests for resource types, filters, preview/null/truncated states, stale data, permissions, and responsive details.
- Live non-mutating probe and one bounded inventory query when an authorized tenant is available; do not record tenant data in fixtures or completion files.

## Aggregate validation

Run the global validation baseline and compute the exact-ID projection twice from the same allowed fixture fields to prove identical output.

## Production continuation

Preview rollout, role, conditional-access, or tenant-data unavailability does not stop the campaign. Keep Power Platform inventory disabled or stale-labeled, retain package behavior, and carry exact probe evidence and remediation. Do not replace package data with an empty inventory response.

## Scope guard

Do not implement quarantine mutations, transcript retrieval, official usage ingestion, Purview, or Defender. Do not infer identity from names. Do not deploy to Azure.

## Completion record

Create `plans/admin-poc-production/completions/04-power-platform-inventory.md` with resource coverage, permission/role probe evidence, identity rules, schema/preview limitations, and Phase 05 preconditions.

## Done conditions

- Supported Power Platform inventory is queryable and exportable with truthful role-scoped coverage.
- Copilot Studio and Agent Builder classification is richer and source-provenanced.
- Cross-source associations are exact and scope-safe; unresolved/ambiguous records remain separate without a review workflow.
- Phase 05 can attach package controls to normalized agents without changing identity authority.
