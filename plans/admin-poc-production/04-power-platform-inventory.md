# Phase 04 - Power Platform Inventory and Normalized Identity

## Mission

Integrate the Power Platform Resource Query API, expose its supported inventory explorer, enrich Copilot Studio and Agent Builder agents, and establish deterministic cross-source identity reconciliation without name-based joins.

## Prerequisites

- Read the roadmap and completion records for Phases 01-03.
- Capability registry, incremental consent, durable jobs/checkpoints/observations, normalized identity tables, and Permission Center must be operational.
- Do not deploy in this phase.

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
- Power Platform service-principal tokens use RBAC rather than Entra application permissions, but no exact inventory-capable app-only role is documented consistently. Keep app-only inventory disabled unless current Microsoft documentation names the assignment and a live probe passes.

## Required implementation

1. Implement a typed Resource Query adapter with timeouts, bounded retries, `Top` plus `skipToken` pagination, response validation, throttling handling, and query-clause builders. Do not concatenate user-provided KQL expressions.
2. Ingest the inventory resource types supported by the current API: Copilot Studio/Agent Builder agents, agent flows/workflow agent flows, Power Apps resource types, Power Automate cloud flows, connectors, environments, and environment groups. Retain role-scoped omissions as `not_authorized_scope`, not as zero resources.
3. Provide an inventory explorer with server-side filtering, sorting, pagination, counts, source freshness, CSV export, and type-specific detail. It must demonstrate the API's available inventory while keeping the agent workbench primary.
4. For `microsoft.copilotstudio/agents`, normalize all documented fields including source authoring tool, Dataverse/CDS bot ID, environment, owner/creator, created/published timestamps, draft/published state, quarantine state, managed state, Entra app/agent/blueprint IDs, orchestration, model, authentication, channels, viewer/editor sharing, capability counts, connectors/operations, connection provider, end-user consent, invocation rules, and web-search use.
5. Preserve GA versus preview status per field. Display missing/null fields as not supplied, not false. Mark the 200-resources-per-type capability detail truncation and preserve total capability counts.
6. Implement source identifiers and deterministic links among package ID/app ID/manifest ID/asset ID, Dataverse bot ID, environment ID, Entra app ID, Entra Agent ID, and blueprint ID. Auto-link only exact identifiers under documented relationships.
7. Store ambiguous candidates as identity conflicts with evidence and a review state. A manual link/unlink action requires `AgentControl.Administrator`, is revision-fenced, audited, and never mutates provider-native observations.
8. Replace `shortDescription` parsing as classification authority. Keep it only as a labeled package hint when no authoritative field exists. The normalized projection exposes `sourceSystem`, `authoringTool`, `creatorType`, `agentKind`, `lifecycle`, `identityConfidence`, and per-field provenance.
9. Schedule bounded refresh with manual refresh, last-success/last-attempt visibility, deleted-resource tombstones, and a conservative stale threshold based on Microsoft's typical 15-20 minute refresh latency.
10. Handle sovereign-cloud support differences, classic/V1 bot exclusion, unpublished configuration caveats, hidden workflow environments, conditional-access failures involving Azure Resource Manager, and preview connector inventory.

## Focused validation

- Adapter tests for pagination, empty/partial/truncated pages, schema drift, duplicate resources, throttling, malformed free-form properties, role-scoped omissions, and sovereign clouds.
- Identity tests for every documented ID, exact links, ambiguous collisions, unlink/relink, deleted sources, and projection rebuild determinism.
- Migration/repository tests for observations, tombstones, checkpoints, and refresh restart.
- UI tests for resource types, filters, preview/null/truncated states, stale data, permissions, and responsive details.
- Live non-mutating probe and one bounded inventory query when an authorized tenant is available; do not record tenant data in fixtures or completion files.

## Aggregate validation

Run the global validation baseline and rebuild normalized projections twice from the same fixture observations to prove identical output.

## Production continuation

Preview rollout, role, conditional-access, or tenant-data unavailability does not stop the campaign. Keep Power Platform inventory disabled or stale-labeled, retain package behavior, and carry exact probe evidence and remediation. Do not replace package data with an empty inventory response.

## Scope guard

Do not implement quarantine mutations, transcript retrieval, official usage ingestion, Purview, or Defender. Do not infer identity from names. Do not deploy.

## Completion record

Create `plans/admin-poc-production/completions/04-power-platform-inventory.md` with resource coverage, permission/role probe evidence, identity rules, schema/preview limitations, and Phase 05 preconditions.

## Done conditions

- Supported Power Platform inventory is queryable and exportable with truthful role-scoped coverage.
- Copilot Studio and Agent Builder classification is richer and source-provenanced.
- Cross-source identity is exact, conflict-aware, auditable, and never name-based.
- Phase 05 can attach package controls to normalized agents without changing identity authority.
