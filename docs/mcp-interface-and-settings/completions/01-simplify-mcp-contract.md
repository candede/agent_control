# Phase 01 — simplified native MCP contract

## Phase result and identity

**Complete.** All phase-required software and isolated SDK/API checks passed.
This is phase 01 of 03, not campaign completion or production qualification.
No intermediate deployment occurred. Phase 02 and the mandatory phase 03 normal
`seha` deployment/ten-minute observation remain owned by the parent campaign.
There is no added acceptance, enablement, manual-sync or runtime release gate.

- Executed 2026-11-04 in `/Users/candede/repos/agent365/agent_control`, initial
  HEAD `6266feca`; initial worktree contained only the parent's new campaign record.
- Parent-confirmed machine launch: `gpt-6.1-sol`, `reasoning_effort=xhigh`.
  No nested agent, commit, push or branch creation.
- Phase SHA-256: `f212cddcbfc3836199ae2048da876aa3d0d30c7e163f79e73561ec962844dde5`.
  Binding README SHA-256:
  `3caa68e855bd4a5de2c185a123451ad76cdc8e7119ddb81eddc1095492d8a1b5`.
- Python 3.14.6; MCP SDK 2.3.0; FastMCP 4.1.0. Pylance unavailable;
  verified runtime SDK signatures, Pydantic validation, tests, Ruff and mypy instead.

Final runtime source SHA-256:

| File under `mcp/src/agent_control_mcp/` | SHA-256 |
| --- | --- |
| `domains.py` | `40dfbcf16b8ef747bb2eefe3cecf1104f01b293dec53d5fa25f82f07399722f5` |
| `instructions.py` | `0fcbcf3ce274ff1a676bfe4dc687f1096430d7f0863bfa586db4706d20d89507` |
| `service.py` | `455e1eef3f20efbfd0d4dfa2cd381acdb81fab52854b1866975940585295a4d8` |
| `tools.py` | `5e1ff548e9c4b5c3ca799fed98d49c0278d99686abc9a87f2984ae4b71118835` |

## Implemented and deleted contracts

- Replaced 124 individual registrations with **62 tools: 22 typed domain families
  and 40 deliberately explicit standalone tools**. Every one of the 124 canonical
  operations is reachable exactly once. Canonical routes, DTOs, provider identities,
  role checks, selections, cursors, errors, attribution and lifecycle handlers remain.
- Family request: `{"request":{"action":"<literal>","input":<exact original DTO>}}`.
  Family structured/text result: `{"action":"<same literal>","result":<full original result>}`.
  Standalone request/result contracts remain direct. Unknown actions, absent
  required fields, cross-variant fields, arbitrary URLs/routes and extra fields fail.
- Kept provider work separate from saved reads and kept provider-specific
  preview/execute/resume/reconcile/cancel/cache-deletion boundaries. Package
  block/access execution uses finite typed intent/target variants, never a generic
  control executor. No universal job lifecycle, expensive summary fan-out or new writer.
- Removed **84 replaced public names**, with no advertised or callable aliases.
  These are precisely the non-direct rows in the capability mapping below.
  Forty direct identities remain intentionally supported. Needed internal canonical
  names and business DTOs are not compatibility aliases and were retained.
- Kept one invocation around one canonical call. Its existing 60-second deadline,
  request/exchange budgets, OBO, cancellation and write-retry policy are unchanged.
  Output accounting now charges the action wrapper and both complete SDK output
  representations against the same 524,288-byte budget, not a new/reset allowance.
- Added the sole MCP-owned `INSTRUCTIONS` in `instructions.py` and supplied it to
  `FastMCP(instructions=...)`: **462 whitespace-delimited words**, exact SDK equality
  tested. It covers saved/provider reads, domains, exact selections, all paging/About,
  unknown/partial evidence, confirmations, provider recovery and inert source text.
- `/diagnostics.businessTools` counts registered public tools; the separate
  `canonicalOperations` field remains 124.
- Updated the cloud client's read-only allowlist, all documented first reads,
  discovery-refresh guidance, native/container/SQL fixture adapters, shared corpus,
  schema/safety/count tests and the existing isolated integration owner.
- No phase 02 endpoint, credential, metadata consumer, settings page, dependency,
  schema, migration, authentication or deployment-setting change.

## Measured discovery, before any registration edits and after

Hypothesis: coherent typed families preserve the finite canonical bindings while
reducing both tool selection count and full discovery bytes. The first SDK capture
and complete branch/schema tests were the falsifying checks.

The real MCP `ClientSession` initialized the service over the existing authenticated
ASGI/Streamable HTTP fixture and exhausted `tools/list` cursors. Both captures used
the same SDK and serializer, including complete initialize fields and all tool
input/output schemas, annotations, descriptions and metadata:

```python
document = {
    "initialize": initialized.model_dump(mode="json", by_alias=True, exclude_none=True),
    "tools": [tool.model_dump(mode="json", by_alias=True, exclude_none=True) for tool in tools],
}
json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
```

| Actual SDK measurement | Before | Final |
| --- | ---: | ---: |
| Public tools | 124 | 62 |
| Complete UTF-8 bytes | 1,130,328 | 677,526 |
| Initialize instructions | absent/null | exact `INSTRUCTIONS`, 462 words |
| SHA-256 | `f74b993ccb15e04e4a73b0324207c243d6b1ad5776c94c10b11dbeffd6ca8893` | `5b2d01fcba4e710c9c8ba060f7c38d1b0c3b828fc32178ab52a9b20e38950609` |

Reduction: **452,802 bytes (40.0593%)**, alongside the 50% tool-count reduction.
No schema/description truncation was used. FastMCP's supported
`dereference_schemas=False` preserves complete standard local `$defs` references
and discriminators instead of repeating expanded nested DTOs. Initially grouping
alone produced 68 tools/1,134,321 bytes: that failed the target. Splitting safety
classes correctly, consolidating same-class package execution variants and
preserving schema references produced the measured final contract.

Sanitized retained evidence:

- Full pre-edit payload: `.local/mcp-interface-phase-01/baseline.json`.
- Full final payload: `.local/mcp-interface-phase-01/final.json`.
- Checked-in baseline receipt and immutable canonical inventory:
  [01-discovery-baseline.measurement.json](01-discovery-baseline.measurement.json).
- Checked-in final receipt:
  [01-discovery-final.measurement.json](01-discovery-final.measurement.json).

The frozen pre-edit inventory test compares all 124 method/path/DTO/provider/
destructive/idempotent records, not just counts. There remain 76 GET, 45 POST,
2 DELETE and 1 PATCH operations, including 37 provider-marked and 16
destructive-marked operations.

## Capability mapping

All rows retain the exact original canonical request/result DTOs shown. For a
`tool/action` row the DTO is nested under request `input` / response `result`;
`(direct)` rows retain the original envelope. No canonical input field, default,
selection binding, optional evidence, nested result or cursor is dropped.

Safety: **S** saved GET (read-only/idempotent hints true), **L** provider-free
local operation (not advertised read-only), **P** provider operation (open-world,
not advertised read-only), **D** original destructive flag, **I** original explicit
idempotent flag. Provider GETs remain P, while selection POSTs remain L.
Role/capability enforcement remains on the exact API handler, not these hints.
The existing provider-identity table in `docs/mcp-reference.md` remains authoritative:
application Graph collection/users, delegated Power Platform, delegated control
providers and delegated-only MCP investigations are unchanged.

| Original canonical operation | Current public tool/action | Unchanged method/route | Original request → result DTO | Safety |
| --- | --- | --- | --- | --- |
| `list_workspace_jobs` | `list_workspace_jobs (direct)` | `GET /api/workbench/jobs` | `Empty` → `WorkspaceJobs` | S |
| `list_capabilities` | `capabilities/list` | `GET /api/capabilities` | `Empty` → `Capabilities` | S |
| `get_capability_check_progress` | `capabilities/progress` | `GET /api/capabilities/check-progress` | `CheckInput` → `CheckProgress` | S |
| `check_capabilities` | `check_capabilities (direct)` | `POST /api/capabilities/check` | `CheckInput` → `Capabilities` | P |
| `probe_capability` | `probe_capability (direct)` | `POST /api/capabilities/{id}/probe` | `ProbeInput` → `CapabilityView` | P |
| `capture_agent_inventory` | `capture_agent_inventory (direct)` | `POST /api/agent-inventory/selections` | `InventoryCapture` → `InventoryCaptureResult` | L |
| `list_agents` | `inventory/list` | `GET /api/agent-inventory` | `InventoryList` → `InventoryPage` | S |
| `get_inventory_health` | `inventory/health` | `GET /api/agent-inventory/health` | `Empty` → `InventoryHealthResult` | S |
| `get_inventory_summary` | `inventory/summary` | `GET /api/agent-inventory/summary` | `Selected` → `SelectedSummary` | S |
| `list_agent_facets` | `inventory/facets` | `GET /api/agent-inventory/facets` | `InventoryFacet` → `InventoryFacets` | S |
| `get_agent` | `inventory/detail` | `GET /api/agent-inventory/{recordId}/detail` | `AgentSelected` → `Agent` | S |
| `list_agent_members` | `inventory/members` | `GET /api/agent-inventory/{recordId}/members` | `AgentSelected` → `Members` | S |
| `list_agent_children` | `inventory/children` | `GET /api/agent-inventory/{recordId}/children` | `AgentChildren` → `Children` | S |
| `list_agent_sections` | `inventory/sections` | `GET /api/agent-inventory/{recordId}/sections` | `AgentSections` → `Sections` | S |
| `read_agent_about` | `inventory/about` | `GET /api/agent-inventory/{recordId}/about` | `AboutInput` → `AgentAboutPage` | S |
| `list_agent_responsibility` | `inventory/responsibility` | `GET /api/agent-responsibility` | `ResponsibilityInput` → `Responsibility` | S |
| `resolve_agent_people` | `resolve_agent_people (direct)` | `POST /api/agent-inventory/people/resolve` | `ResolvePeople` → `ResolvedPeople` | P |
| `capture_packages` | `capture_packages (direct)` | `POST /api/agents/selections` | `InventoryCapture` → `PublishedSelectedRead` | L |
| `list_packages` | `packages/list` | `GET /api/agents` | `InventoryList` → `PackagePage` | S |
| `get_package` | `packages/detail` | `GET /api/agents/{id}/detail` | `PackageDetailInput` → `PackageDetail` | S |
| `get_native_agent_activity` | `native_inventory/activity` | `GET /api/inventory/resources/{nativeId}/related` | `NativeActivityInput` → `NativeActivity` | S |
| `resolve_studio_targets` | `native_inventory/studio_targets` | `GET /api/inventory/quarantine-selection` | `StudioTargetsInput` → `StudioTargets` | S |
| `list_users` | `users/list` | `GET /api/copilot-usage/users` | `UsersInput` → `ReportPage[CombinedUser]` | S |
| `list_user_facets` | `users/facets` | `GET /api/copilot-usage/users/facets` | `ReportFacetInput` → `ReportFacets` | S |
| `list_unresolved_users` | `users/unresolved` | `GET /api/copilot-usage/users/unresolved-identities` | `UsersInput` → `ReportPage[UnresolvedUser]` | S |
| `resolve_user` | `users/resolve` | `GET /api/copilot-usage/users/resolve` | `ResolveUser` → `UserResolution` | S |
| `get_user` | `users/detail` | `GET /api/copilot-usage/users/{objectId}` | `UserDetailInput` → `ReportDetail[CombinedUser]` | S |
| `list_user_service_plans` | `users/service_plans` | `GET /api/copilot-usage/users/{objectId}/service-plans` | `UserDetailInput` → `ReportPage[ServicePlan]` | S |
| `list_user_used_agents` | `users/used_agents` | `GET /api/copilot-usage/users/{objectId}/agents` | `UserUsedAgentsInput` → `ReportPage[ReportRelationship]` | S |
| `list_user_agent_relationships` | `users/relationships` | `GET /api/copilot-usage/users/{objectId}/agent-relationships` | `SavedRelationshipsInput` → `SavedRelationships` | S |
| `list_adoption_groups` | `adoption/groups` | `GET /api/copilot-usage/adoption` | `AdoptionInput` → `AdoptionPage` | S |
| `list_adoption_facets` | `adoption/facets` | `GET /api/copilot-usage/adoption/facets` | `ReportFacetInput` → `ReportFacets` | S |
| `list_champion_agents` | `adoption/champion_agents` | `GET /api/copilot-usage/adoption/champions` | `ChampionsInput` → `ChampionAgents` | S |
| `list_report_agents` | `report_agents/list` | `GET /api/official-usage/aggregate` | `ReportAgentsInput` → `ReportPage[ReportAgent]` | S |
| `list_report_agent_facets` | `report_agents/facets` | `GET /api/official-usage/aggregate/facets` | `ReportFacetInput` → `ReportFacets` | S |
| `list_report_users` | `report_users/list` | `GET /api/official-usage/users` | `ReportUsersInput` → `ReportPage[ReportUser]` | S |
| `list_report_user_facets` | `report_users/facets` | `GET /api/official-usage/users/facets` | `ReportFacetInput` → `ReportFacets` | S |
| `list_report_relationships` | `report_datasets/relationships` | `GET /api/official-usage/agent-users` | `RelationshipInput` → `ReportPage[ReportRelationship]` | S |
| `get_report_agent` | `report_agents/detail` | `GET /api/official-usage/agents/{agentId}` | `ReportAgentDetail` → `ReportDetail[ReportAgent]` | S |
| `list_report_agent_users` | `report_agents/users` | `GET /api/official-usage/agents/{agentId}/users` | `ReportAgentUsers` → `ReportPage[ReportRelationship]` | S |
| `get_report_user` | `report_users/detail` | `GET /api/official-usage/users/{username}` | `ReportUserDetail` → `ReportDetail[ReportUser]` | S |
| `list_report_user_agents` | `report_users/agents` | `GET /api/official-usage/users/{username}/agents` | `ReportUserAgents` → `ReportPage[ReportRelationship]` | S |
| `get_report_user_directory` | `report_users/directory` | `GET /api/official-usage/users/{username}/directory` | `ReportUserDetail` → `ReportDetail[CombinedUser]` | S |
| `list_report_user_service_plans` | `report_users/service_plans` | `GET /api/official-usage/users/{username}/service-plans` | `ReportUserDetail` → `ReportPage[ServicePlan]` | S |
| `list_report_history` | `report_datasets/history` | `GET /api/official-usage/history` | `HistoryInput` → `ReportPage[HistorySet]` | S |
| `list_report_options` | `report_datasets/options` | `GET /api/official-usage/history/options` | `HistoryInput` → `ReportList[HistorySet]` | S |
| `list_report_observations` | `report_datasets/observations` | `GET /api/official-usage/history/{setId}/observations` | `ObservationsInput` → `ReportPage[Observation]` | S |
| `get_report_overview` | `report_datasets/overview` | `GET /api/official-usage/overview` | `OverviewInput` → `ReportPage[OverviewAgent]` | S |
| `get_agent_usage` | `agent_usage/summary` | `GET /api/agent-inventory/{recordId}/usage` | `UsageInput` → `UsageSummary` | S |
| `list_agent_usage_history` | `agent_usage/history` | `GET /api/agent-inventory/{recordId}/usage-history` | `UsageHistoryInput` → `UsageHistory` | S |
| `list_agent_usage_users` | `agent_usage/users` | `GET /api/agent-inventory/{recordId}/usage-users` | `UsageUsersInput` → `UsageUsers` | S |
| `list_agent_usage_associations` | `agent_usage/associations` | `GET /api/agent-inventory/{recordId}/usage-associations` | `UsageInput` → `UsageAssociations` | S |
| `list_agent_usage_candidates` | `agent_usage/candidates` | `GET /api/agent-inventory/{recordId}/usage-candidates` | `UsageCandidatesInput` → `UsageCandidates` | S |
| `get_sync_state` | `sync/state` | `GET /api/data-sync/state` | `Empty` → `SyncState` | S |
| `start_sync` | `collect_sync/start` | `POST /api/data-sync/runs` | `StartSync` → `SyncRun` | P |
| `get_sync_run` | `sync/run` | `GET /api/data-sync/runs/{id}` | `JobId` → `SyncRun` | S |
| `retry_sync` | `collect_sync/retry` | `POST /api/data-sync/runs/{id}/retry` | `RetrySync` → `SyncRun` | P |
| `cancel_sync` | `cancel_sync (direct)` | `POST /api/data-sync/runs/{id}/cancel` | `JobId` → `SyncRun` | L |
| `get_package_detail_sync` | `get_package_detail_sync (direct)` | `GET /api/data-sync/package-details` | `Empty` → `DetailSyncState` | S |
| `start_package_detail_sync` | `start_package_detail_sync (direct)` | `POST /api/data-sync/package-details/start` | `Empty` → `DetailSyncState` | P |
| `cancel_package_detail_sync` | `cancel_package_detail_sync (direct)` | `POST /api/data-sync/package-details/cancel` | `Empty` → `DetailSyncState` | L |
| `refresh_packages` | `collect_packages/catalog` | `POST /api/agents/refresh-jobs` | `RefreshPackages` → `PackageRefreshJob` | P |
| `refresh_package` | `collect_packages/package` | `POST /api/agents/{id}/refresh-jobs` | `RefreshPackage` → `PackageRefreshJob` | P |
| `refresh_selected_packages` | `collect_packages/selection` | `POST /api/agents/refresh-selection` | `RefreshSelected` → `PackageRefreshJob` | P |
| `list_package_refresh_jobs` | `package_refresh_jobs/list` | `GET /api/agents/refresh-jobs` | `PackageJobs` → `RefreshJobs[PackageRefreshJob]` | S |
| `get_package_refresh_job` | `package_refresh_jobs/detail` | `GET /api/agents/refresh-jobs/{id}` | `PackageJobId` → `PackageRefreshJob` | S |
| `list_package_refresh_targets` | `package_refresh_jobs/targets` | `GET /api/agents/refresh-jobs/{id}/targets` | `PackageTargets` → `RefreshTargets` | S |
| `resume_package_refresh` | `resume_package_refresh (direct)` | `POST /api/agents/refresh-jobs/{id}/resume` | `PackageJobId` → `PackageRefreshJob` | P |
| `cancel_package_refresh` | `cancel_package_refresh (direct)` | `POST /api/agents/refresh-jobs/{id}/cancel` | `PackageJobId` → `PackageRefreshJob` | L |
| `refresh_studio_inventory` | `refresh_studio_inventory (direct)` | `POST /api/inventory/refresh-jobs` | `RefreshStudio` → `StudioRefreshJob` | P |
| `list_studio_refresh_jobs` | `studio_refresh_jobs/list` | `GET /api/inventory/refresh-jobs` | `JobList` → `RefreshJobs[StudioRefreshJob]` | S |
| `get_studio_refresh_job` | `studio_refresh_jobs/detail` | `GET /api/inventory/refresh-jobs/{id}` | `JobId` → `StudioRefreshJob` | S |
| `resume_studio_refresh` | `resume_studio_refresh (direct)` | `POST /api/inventory/refresh-jobs/{id}/resume` | `JobId` → `StudioRefreshJob` | P |
| `cancel_studio_refresh` | `cancel_studio_refresh (direct)` | `POST /api/inventory/refresh-jobs/{id}/cancel` | `JobId` → `StudioRefreshJob` | L |
| `search_access_principals` | `access_principals/search` | `GET /api/directory/principals` | `SearchPrincipals` → `DirectoryPrincipals` | P |
| `resolve_access_principals` | `access_principals/resolve` | `POST /api/directory/principals/resolve` | `ResolvePrincipals` → `DirectoryPrincipals` | P |
| `get_agent_investigation` | `get_agent_investigation (direct)` | `GET /api/agent-inventory/investigations/context` | `InvestigationInput` → `InvestigationContext` | S |
| `resolve_agent_identity` | `resolve_agent_identity (direct)` | `POST /api/agent-inventory/investigations/resolve` | `InvestigationInput` → `InvestigationContext` | P |
| `list_agent_purview_records` | `purview/agent_records` | `GET /api/agent-inventory/investigations/purview` | `AgentPurviewInput` → `AgentPurviewRecords` | S |
| `get_purview_catalog` | `purview/catalog` | `GET /api/audit-search/catalog` | `Empty` → `PurviewCatalog` | S |
| `start_purview_search` | `start_purview_search (direct)` | `POST /api/audit-search/jobs` | `StartPurview` → `PurviewJob` | P |
| `list_purview_jobs` | `purview/jobs` | `GET /api/audit-search/jobs` | `PurviewHistory` → `JobHistory[PurviewJob]` | S |
| `get_purview_job` | `purview/job` | `GET /api/audit-search/jobs/{id}` | `JobId` → `PurviewJob` | S |
| `resume_purview_search` | `resume_purview_search (direct)` | `POST /api/audit-search/jobs/{id}/resume` | `JobId` → `PurviewJob` | P |
| `cancel_purview_search` | `cancel_purview_search (direct)` | `POST /api/audit-search/jobs/{id}/cancel` | `JobId` → `PurviewJob` | L |
| `delete_purview_cache` | `delete_purview_cache (direct)` | `DELETE /api/audit-search/jobs/{id}` | `DeleteCache` → `Deleted` | LD |
| `list_purview_records` | `purview/records` | `GET /api/audit-search/jobs/{id}/records` | `PurviewRecordsInput` → `PurviewRecords` | S |
| `get_hunting_catalog` | `hunting/catalog` | `GET /api/hunting/catalog` | `HuntingTarget` → `HuntingCatalog` | S |
| `start_hunt` | `start_hunt (direct)` | `POST /api/hunting/jobs` | `StartHunt` → `HuntingJob` | P |
| `list_hunting_jobs` | `hunting/jobs` | `GET /api/hunting/jobs` | `HuntingHistory` → `JobHistory[HuntingJob]` | S |
| `get_hunting_job` | `hunting/job` | `GET /api/hunting/jobs/{id}` | `HuntingJobInput` → `HuntingJob` | S |
| `resume_hunt` | `resume_hunt (direct)` | `POST /api/hunting/jobs/{id}/resume` | `HuntingJobInput` → `HuntingJob` | P |
| `cancel_hunt` | `cancel_hunt (direct)` | `POST /api/hunting/jobs/{id}/cancel` | `HuntingJobInput` → `HuntingJob` | L |
| `delete_hunting_cache` | `delete_hunting_cache (direct)` | `DELETE /api/hunting/jobs/{id}` | `DeleteHuntingCache` → `Deleted` | LD |
| `list_hunting_rows` | `hunting/rows` | `GET /api/hunting/jobs/{id}/rows` | `HuntingRowsInput` → `HuntingRows` | S |
| `list_administrative_audit` | `list_administrative_audit (direct)` | `GET /api/audit/events` | `AuditInput` → `AuditEvents` | S |
| `preview_agent_control` | `preview_agent_control (direct)` | `POST /api/agent-controls/preview` | `PreviewAgentControl` → `AgentControlPreview` | P |
| `execute_agent_control` | `execute_agent_control (direct)` | `POST /api/agent-controls/execute` | `ExecuteAgentControl` → `AgentControlExecution` | PDI |
| `get_agent_control` | `get_agent_control (direct)` | `GET /api/agent-controls/{receiptId}` | `AgentControlReceipt` → `AgentControlExecution` | S |
| `count_package_targets` | `count_package_targets (direct)` | `POST /api/agents/mutation-selection` | `CountPackageTargets` → `TargetCount` | L |
| `preview_package_control` | `preview_package_control (direct)` | `POST /api/agents/mutation-preview` | `PreviewPackageControl` → `PackagePreview` | P |
| `block_packages` | `set_package_block/block_ids` | `POST /api/agents/block` | `SubmitPackages` → `PackageJob` | PDI |
| `unblock_packages` | `set_package_block/unblock_ids` | `POST /api/agents/unblock` | `SubmitPackages` → `PackageJob` | PDI |
| `block_selected_packages` | `set_package_block/block_selection` | `POST /api/agents/block-all` | `SubmitSelectedPackages` → `PackageJob` | PDI |
| `unblock_selected_packages` | `set_package_block/unblock_selection` | `POST /api/agents/unblock-all` | `SubmitSelectedPackages` → `PackageJob` | PDI |
| `block_package` | `set_package_block/block_one` | `POST /api/agents/{id}/block` | `SubmitPackage` → `PackageJob` | PDI |
| `unblock_package` | `set_package_block/unblock_one` | `POST /api/agents/{id}/unblock` | `SubmitPackage` → `PackageJob` | PDI |
| `update_packages_access` | `set_package_access/ids` | `POST /api/agents/access` | `UpdatePackagesAccess` → `PackageJob` | PDI |
| `update_package_access` | `set_package_access/one` | `PATCH /api/agents/{id}/access` | `UpdatePackageAccess` → `PackageJob` | PDI |
| `list_package_control_jobs` | `package_control_jobs/list` | `GET /api/agents/bulk-jobs` | `JobList` → `PackageJobs` | S |
| `get_package_control_job` | `package_control_jobs/detail` | `GET /api/agents/bulk-jobs/{id}` | `JobId` → `PackageJob` | S |
| `list_package_control_items` | `package_control_jobs/items` | `GET /api/agents/bulk-jobs/{id}/items` | `PackageItems` → `PackageItems` | S |
| `cancel_package_control` | `cancel_package_control (direct)` | `POST /api/agents/bulk-jobs/{id}/cancel` | `JobId` → `PackageJob` | LD |
| `resume_package_control` | `resume_package_control (direct)` | `POST /api/agents/bulk-jobs/{id}/resume` | `ResumeControl` → `PackageJob` | PD |
| `reconcile_package_control` | `reconcile_package_control (direct)` | `POST /api/agents/bulk-jobs/{id}/reconcile` | `JobId` → `ReconciledPackageJob` | P |
| `get_studio_status` | `get_studio_status (direct)` | `GET /api/quarantine/status` | `StudioStatus` → `StudioStatus` | P |
| `preview_studio_control` | `preview_studio_control (direct)` | `POST /api/quarantine/preview` | `PreviewStudioControl` → `StudioPreview` | P |
| `execute_studio_control` | `execute_studio_control (direct)` | `POST /api/quarantine/jobs` | `ExecuteStudioControl` → `StudioJob` | PDI |
| `list_studio_control_jobs` | `studio_control_jobs/list` | `GET /api/quarantine/jobs` | `JobList` → `StudioJobs` | S |
| `get_studio_control_job` | `studio_control_jobs/detail` | `GET /api/quarantine/jobs/{id}` | `JobId` → `StudioJob` | S |
| `cancel_studio_control` | `cancel_studio_control (direct)` | `POST /api/quarantine/jobs/{id}/cancel` | `JobId` → `StudioJob` | LD |
| `resume_studio_control` | `resume_studio_control (direct)` | `POST /api/quarantine/jobs/{id}/resume` | `ResumeControl` → `StudioJob` | PD |
| `reconcile_studio_control` | `reconcile_studio_control (direct)` | `POST /api/quarantine/jobs/{id}/reconcile` | `JobId` → `ReconciledStudioJob` | P |
| `list_studio_control_audit` | `studio_control_jobs/audit` | `GET /api/quarantine/audit` | `StudioAudit` → `StudioAudit` | S |

All selection/result paging and original recovery semantics apply to every row.
In particular, provider-free selection capture never probes/refreshes; source-bound
About continues explicit segments; accepted controls are not verified success;
unsent resume requires fresh same-principal authority; sent-unknown writes require
provider-specific GET-only reconciliation, never resend; cancel does not undo
effects; cache deletion confirms the exact job without deleting provider records.

## Validation commands and actual results

Commands ran from the repository root unless `cd mcp` is shown. Logs are retained
under `.local/mcp-interface-phase-01/`; no host dependencies were installed.
Authorized image builds used only the configured Microsoft package proxies.

### SDK baseline, focused and aggregate Python

```sh
mkdir -p .local/mcp-interface-phase-01
cd mcp
MCP_DISCOVERY_EVIDENCE=../.local/mcp-interface-phase-01/baseline.json \
  .venv/bin/python -m pytest --basetemp=../.local/mcp-interface-phase-01/baseline-pytest \
  tests/test_discovery.py -q -s
```

**Passed: 1 test**, actual pre-edit 124-tool capture. Preliminary measurement
attempts failed on a missing basetemp parent, then SDK 2.3's two-item transport
tuple and `list_tools(params=PaginatedRequestParams(...))` signature. These were
repaired using installed runtime signatures before any registration edit.

```sh
cd mcp
MCP_DISCOVERY_EVIDENCE=../.local/mcp-interface-phase-01/final.json \
  .venv/bin/python -m pytest --basetemp=../.local/ac-mcp-interface-phase-01 \
  -o addopts='' -q tests/test_discovery.py tests/test_tools.py tests/test_controls.py \
  tests/test_workflows.py tests/test_client_examples.py tests/test_onboarding.py \
  tests/test_api_origin.py tests/test_oauth.py
```

**Passed: 637 tests, 167.31 seconds.** This includes 248 minimal/complete nested
canonical branch calls, strict request/result validation, exact method/path forwarding,
OAuth and origin attribution, browser-adapter parity, full Unicode/About paging,
provider failures/claims, exact selections, current preview/confirm/reconcile,
no automatic write retry, cancellation and exact representable SDK output limits.
An earlier focused run had five failures: four stale canonical-name trace assertions
and one pre-family envelope boundary expectation. Updated assertions now verify the
actual public family/action and full final envelope, without relaxing the limit.

After naming generated schemas and checking exact wire schema/discriminator equality:

```sh
cd mcp
MCP_DISCOVERY_EVIDENCE=../.local/mcp-interface-phase-01/final.json \
  .venv/bin/python -m pytest --basetemp=../.local/mcp-interface-phase-01/final-discovery \
  -o addopts='' -q tests/test_discovery.py \
  tests/test_tools.py::test_discovered_schemas_annotations_and_omitted_boundaries
.venv/bin/python -m pytest --basetemp=../.local/ac-mcp-interface-phase-01-all \
  -o addopts='' -q tests
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

- Final SDK/schema slice: **4 passed**.
- Final handoff discovery rerun: **3 passed**, 1.05 seconds; same discovery identity.
  Strengthened removed-name checks to require an explicit `Unknown tool` result
  (not merely validation failure): **3 passed**, 0.88 seconds; Ruff passed again.
- Complete MCP aggregate: **824 passed, 21 skipped**, 183.22 seconds.
  All 21 skips require the guarded Azure OAuth emulator endpoint; that unchanged
  external storage leg is unavailable, not passed.
- Ruff: **passed**. Mypy: **passed, 22 source files**.
- SDK checks also call all 84 removed names directly and verify rejection without
  additional API calls; the native first saved read validates its full family result.

### Existing isolated real SDK → canonical API → SQL owner

Read `scripts/large-tenant-tests.ps1`, `scripts/local-mcp-fixture.ps1`,
the fixture ownership/cleanup contract and `docs/operations.md` before invocation.
Verified `desktop-linux` and
`unix:///Users/candede/.docker/run/docker.sock`, with no context/host override.
Reused the parent's independently verified arm64/Node v24.20.0 baseline evidence:
all four package manifests match this checkout exactly.

```powershell
pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 `
  -Suite mcp-end-to-end `
  -BaselineImage agent-control-import-fix-eaf8369f-dependencies:local `
  -BaselineImageId sha256:7d398a507b26ead060f6fe949abd9b498331f0dae8786e33b42b027d760f9d34
```

**Passed twice**, including the final named-schema source. The existing suite now
selects all phase-required backend wire/auth/feasibility checks in the same runner:

```sh
npm run test --workspace backend -- src/routes/mcpContractFeasibility.test.ts \
  src/routes/mcpApiAuth.test.ts src/routes/mcpReadContracts.test.ts \
  src/routes/sharedAgentControls.test.ts scripts/largeTenantFixture.test.ts --silent=false
npm run typecheck --workspace backend
```

Final result: **5 files / 98 tests passed**, backend typecheck passed. The test
command took 94,715 ms; typecheck took 2,822 ms. `AGENT_CONTROL_MCP_SQL_JOURNEY`
actually reached the test process: **12 SDK journeys / 58 real HTTP API calls**,
3,322,332 total response bytes, largest call 511,010 bytes, slowest call
0.343163 seconds. Journey call counts were `16,16,8,8,2,2,1,1,1,1,1,1`.
Native traces include `users`, `inventory`, `adoption`, `agent_usage` and explicit
control preview/execution/status, with real SQL selections and 100+1 pagination.
The SDK leg was not inferred from backend-only success.

Final evidence directory:
`artifacts/large-tenant-data-platform/43c02a2285274401bf6ab7e82c92cc25/`;
earlier passing run:
`artifacts/large-tenant-data-platform/b604533272574c3da4ce2472829a1c1e/`.
Both `result.json` receipts have empty failure arrays.

Final built SDK image:
`sha256:6e8acb2e6fd36c32176dac9e3bebe22de0348271a604a632766c7e821f86dbb3`;
final combined operator:
`sha256:5342fdceff70b51e1e6651328f58408a221f722d2661d35285d4bf9f7066abed`.
Both were disposable and removed after proof.

### Unchanged browser journey and static checks

```sh
npm run test --workspace frontend -- src/App.session.test.tsx \
  src/components/FirstSyncNotice.test.tsx src/components/dataSync.test.ts \
  src/api/client.test.ts
npm run typecheck --workspace backend
git diff --check
```

**Passed: 4 frontend files / 629 tests**, including first-sign-in read-only
automatic sync and the actual browser API adapters. Host backend typecheck passed;
diff hygiene passed. These tests are software fixtures, not a claim of interactive
production sign-in or model-assisted selection.

Additional final reference/selector attempt:

```sh
npm run test --workspace backend -- src/routes/mcpContractFeasibility.test.ts \
  scripts/largeTenantFixture.test.ts
npm run test --workspace backend -- src/routes/mcpContractFeasibility.test.ts
```

The first host invocation **failed: 44 passed / 2 failed**. The two existing SQL
fixture cases correctly refused the unconfigured host database before opening a
connection (`Tests require a separately named agentcontrol_test_* database`).
That host attempt remains failed, not reclassified passed. Both exact cases had
already passed on unchanged backend source in **both** authorized isolated
98-test runs above; that is the applicable SQL proof. The narrower final pure
feasibility/reference command **passed: 20 tests**, 1.27 seconds. No production
database, ambient PG override or weakened fixture safeguard was used.

## Cross-root producer/consumer impact

All roots are this one repository. Existing unrelated changes were preserved.

| Root | Changed files / checked contract |
| --- | --- |
| `mcp` | Added `domains.py`, `instructions.py`; updated `tools.py`, `service.py`, cloud allowlist, `conftest.py`, `container_journey.py`, tool/OAuth/onboarding/client/workflow tests; added `public_contract.py` and `test_discovery.py`. |
| `backend` | Updated `scripts/fixtures/mcp-workflows.json`, existing `largeTenantFixture.ts` selector and its tests, `mcpContractFeasibility.test.ts`, and clarified canonical-operation naming in `mcpSdkJourneyTestSupport.ts`. No business API producer or DTO change. |
| `docs` | Updated MCP reference, integration, clients and Azure deployment's client invocation; added this completion and sanitized measurement receipts. Plan prompts and parent campaign record unchanged. |
| `frontend` | Checked application/API adapters and test-only browser parity bridge. They call the unchanged canonical HTTP APIs, not public MCP names. No source edit required; 629 first-run/API tests and MCP/browser workflow parity passed. |
| `scripts` | Traced `large-tenant-tests.ps1`, local MCP fixture and diagnostics/cleanup owners. Their existing SDK environment/source wiring actually executed 58 calls; no runner fork or script edit was necessary. Phase 02's MCP-only/browser-image repairs were not implemented here. |
| `infra` / root Compose/Docker | Checked deployment/template and package-feed boundaries. This public catalog change adds no setting, secret, route, port or deployment owner. No infrastructure/template edit required. Existing SDK image build consumes changed current Python source. |

Canonical names in the existing browser parity bridge and SQL call expectations
are intentionally internal operation identifiers. The single test adapter resolves
current public bindings from `PUBLIC_TOOLS`, validates/unpacks the action envelope
and records actual public wire names. It is not a callable compatibility alias,
duplicated runtime catalog or business implementation. Complete wire envelopes
are asserted independently before any test-only unpacking.

## Autonomous decisions and retained complexity

- Used the existing operation/DTO owner and explicit cohesive domain declarations,
  not 124 handwritten wrappers or a generic request/HTTP executor.
- Nested `input` avoids collisions with real business `action` fields and retains
  original validators, strictness, omitted defaults and full DTO schemas. Generated
  literal discriminators and named root models are necessary for native validation.
- Chose standard local schema references using the supported FastMCP option after
  real discovery disproved grouping-only size reduction. Nothing was truncated.
- Grouped same-safety package block/unblock and access executions by explicit intent
  and target shape; previews and provider-specific sensitive recovery remain standalone.
- Moved repeated inert-data/paging/recovery guidance into the single initialize
  instruction, preserving every canonical operation description in its domain.
- Extended the existing integration selector rather than introducing a new runner.
  Its current SDK flag/wiring worked; there was no evidence justifying a second path.
- No data/OAuth persistence format or lifecycle changed; no new restore exercise,
  migration chain, key rotation or production reset was needed or performed.
- No unsettled parent architecture/authority decision remains.

## Authorized lifecycle and cleanup

Only the two exact project-owned disposable stacks above were created. Their
owned PostgreSQL volumes were disk-backed and isolated; all synthetic API/SQL
work stayed inside their existing fixture boundary. The owner captured diagnostics
and removed its containers/volumes. Explicit post-run checks found **zero containers,
zero volumes and zero networks** for each exact project.

Four built images (two SDK, two operator) were independently verified by exact
SHA-256, sole tag, fixture ownership label and absence of container users before
`docker image rm` of only those four exact tags. No prune or broad cleanup.
Receipt: `.local/mcp-interface-phase-01/cleanup.json`.
Nine exact phase-owned pytest state directories were also removed after proof;
sanitized discovery payloads, logs and measurement/cleanup receipts were retained.

The retained services remained running with original image identities:
`seha-app-1` (`2206234c14e7`), `seha-mcp-1` (`1e348498509d`),
`seha-postgres-1` and unrelated `workiq-demo-redis-state-1`.
`seha_data`, `seha_mcp-oauth`, `seha_default`, OAuth keys/state and registrations
were not modified. No production fixture, Entra/tunnel/Azure mutation or deployment.

## Residual evidence boundaries and continuation

No unresolved phase-01 implementation/test failure remains. Do not relabel these
unmeasured external/future-phase proofs as passed or use them to disable working flows:

| Status / scope | Existing containment and numeric signal | Owner / exact continuation |
| --- | --- | --- |
| **Unavailable:** 21 Azure-emulator storage cases, no guarded endpoint supplied; storage implementation unchanged | Existing storage authority/readiness fencing; treat ≥1 storage-authority/readiness failure persisting 60 seconds during final observation as a fix-forward incident | Parent/phase 03: rerun the guarded emulator cases when its approved endpoint is available, or immediately if later work changes OAuth persistence. No Azure provisioning is authorized by this phase. |
| **Not run:** real vendor/model-assisted selection; deterministic clients do not prove an AI selected a correct tool | Real authorization/previews remain enforced; ≥1 wrong tool/action, invented target, unrequested provider call or incomplete paging in the phase-03 selection corpus triggers instruction/schema/client fix-forward | Phase 03 uses the real configured client and records actual results/limitations; do not make a release receipt a runtime prerequisite. |
| **Not run in phase 01:** interactive production sign-in/provider grants and final normal deployment/ten-minute observation | Existing OAuth, API role/provider checks and explicit destructive confirmation remain; ≥1 unauthorized dispatch, automatic write replay or failed saved-read canary is an incident, not empty success | Parent owns phase 02 then the already-authorized phase 03 deployment/observation. Actual interactive authentication is still needed for the corresponding live proof; never fabricate it or reset production to obtain fixtures. |

## Next preconditions

### Parent reconciliation after phase 02

Phase 02's real container capacity/drain run exposed one missed leaf-name caller
in `container_journey.py`; the earlier all-consumer claim was incomplete for
that branch. The current driver now uses the same derived `PUBLIC_TOOLS` test
adapter, preserving all capacity, isolation, recovery and drain assertions.
Driver SHA-256:
`cedf3b72310fca37a8035976bb7658e79dac217862f388586e0d1165f3acfd5d`.
Phase 02 verified 14 successful real container driver executions: the 64-call
burst had 4 successes and 60 expected backpressure responses; two recovery calls
passed; authenticated drain completed in 3.171 seconds against 75 seconds.
No public alias was restored. Parent reviewed and accepted this owner repair;
the original discovery and canonical coverage evidence remains unchanged.

Phase 02 can rely on the current running SDK's **62 registered tools and exact
462-word instructions** as its sole metadata authority, with complete local-schema
references and truthful safety annotations. Read final SDK serialization rather
than rebuilding a TypeScript/Markdown tool catalog. The optional visibility path
must remain independent of normal authentication, saved reads and automatic sync.

Parent should review this completed phase, update its own campaign state, and
start phase 02. Do not deploy the intermediate catalog. Preserve the binding final
phase-03 production convergence contract and all actual residual statuses above.
