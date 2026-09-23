# 01 - Retire the catalog and narrow collection

Reasoning posture: extra-high. Read the roadmap and campaign decisions first.

## Outcome

The application no longer has a standalone Power Platform catalog or supports blanket collection of unrelated objects. Agent and environment sync, diagnostics, exports, identity, activity and controls remain coherent and tested.

## Implementation

1. Narrow the supported Power Platform collection universe to `microsoft.copilotstudio/agents` and `microsoft.powerplatform/environments`. Remove standalone app, flow, connector and environment-group schemas/normalizers/fields used only for catalog records. Keep embedded agent connector operations and contextual environment properties.
2. Make central DataSync and explicit Power Platform source refresh collect the new agent/environment scope. Do not leave the main sync broad while changing only a UI command. Update role/query/coverage bounds, freshness, verification and source messages without converting unrequested/unauthorized into zero.
3. Adjust fresh-development schema constraints and persistence contracts to the reduced universe, without compatibility backfills. Preserve private snapshots, canonical membership and exact native targets.
4. Delete `InventoryExplorer` and its generic detail dialog. Remove the page from App navigation, routes, workbench metadata/types, authorization definitions and page-only CSS. Remove `migratePowerPlatformAgentRoute` and obsolete Power Platform detail-tab aliases, not redirect them.
5. Trace every inventory API/helper/type consumer. Remove page-only snapshot selection, generic non-agent list/filter/export and hardcoded unmatched Package/Reports detail fields. Retain or directly replace the actual agent-specific activity, selection, export and sync consumers; no old/new parallel endpoints.
6. Route Power Platform refresh job details to a real Sync-owned source-job inspection/recovery experience. Ensure exact failed/waiting/running/completed jobs are inspectable and resume/cancel behave correctly. A link pointing to Sync without resolving its exact job is incomplete.
7. Preserve agent package/access controls, quarantine/restore, audit/security associations, people enrichment, and agent CSV export. Do not delete shared verification or styles based on their old names.
8. Update affected unit/browser fixtures, route/policy tests and current docs in this phase. Historic completed plans remain historical.

## Starting evidence

- `frontend/src/components/InventoryExplorer.tsx` excludes agents but retains agent-only quarantine chrome and generic seven-tab detail.
- `backend/src/services/dataSync.ts` currently requests all resource types.
- `backend/src/db/powerPlatformInventory.ts:readUnifiedSource` loads agents and separately looks up current environment rows.
- `frontend/src/components/AgentSyncTools.tsx` already owns source diagnostics.
- `backend/src/routes/workbench.ts:powerPlatformJobSummary` currently links to the retired page.
- `backend/src/routes/inventory.ts` and `frontend/src/api/client.ts` contain shared as well as page-only contracts.

## Verification and handoff

Run focused resource-query, inventory/role-scope, DataSync, workbench routing/metadata/policy, source-job and related frontend tests. Use campaign PostgreSQL for relevant repository/route tests. Run backend and frontend build/typecheck, relevant lint, and `git diff --check`. Fix failures coupled to this phase.

Create `completions/01-retire-catalog-and-narrow-sync.md` with changed contracts, deletion sweep, schema choices, commands/results and cross-root impact. The next phase must have a working agent/environment source and no catalog navigation/compatibility path.
