# 06 - Inventory, people, usage, and investigation tools

## Mission

Implement the complete typed read/tool catalog on top of API contracts, retaining evidence and pagination. Enable LLM reasoning without embedding it in the integration layer.

## Prerequisites

Read [README](README.md), [04](04-api-read-contracts.md), [05](05-fastmcp-service-and-auth.md), and their completion records. Use the frozen tool/endpoint map and shared API adapter. Inspect status and applicable instructions.

## Read first

- API changes and integration documentation from 04; service/auth/client/configuration from 05.
- [Inventory routes](../../backend/src/routes/inventoryData.ts), [report routes](../../backend/src/routes/officialReportData.ts), [investigation routes](../../backend/src/routes/unifiedAgents.ts).
- [Capabilities](../../backend/src/routes/capabilities.ts), [refresh](../../backend/src/routes/dataSync.ts), [Purview](../../backend/src/routes/purviewAudit.ts), [Defender](../../backend/src/routes/defenderHunting.ts), [local audit](../../backend/src/routes/audit.ts).
- [Usage interpretation](../../docs/official-usage-import.md), [Purview contract](../../docs/purview-audit-search.md), [Defender contract](../../docs/defender-agent365-hunting.md).

## Required implementation

1. Implement the 01/04 catalog: data/capability status, agent search/detail/configuration, user resolution/details/license/service plans, used/created/owned relationships, company/department adoption/champions, usage/history/comparison, existing investigations/audit, explicit refresh/enrichment, and job/result polling.
2. Use descriptive tool names/docstrings and finite typed input schemas with enum/filter semantics, UTC units, exact ID requirements, role expectations, and saved-versus-live behavior. Describe how to fetch all pages and full About content.
3. Keep MCP projections thin and call the already accepted canonical HTTP routes used by matching web actions. API results own defaults, selection identities, source associations, counts, joins and trends. If a required API contract is incomplete, repair 04's owner and web consumer rather than calculating it in Python; material shared changes require README's deployed web revalidation/user reacceptance before affected MCP work continues.
4. Preserve total/returned counts, continuation cursors, revisions, source/date/report metadata, freshness/coverage, missing values, report-only rows, and ambiguous matches. Source failures are explicit; no catch-to-empty-list defaults.
5. Expose full available About descriptions and authorized saved configuration sections. Treat source content as untrusted text/data and preserve provenance. No classifier, content instruction execution, raw diagnostics, or inferred authoritative use-case field.
6. Distinguish passive saved status/read tools from explicit provider-working tools. No sync, directory lookup, capability probe, hunting, or audit-query creation during a nominal saved read. Label provider-working investigation/status tools honestly. Official CSV usage has no automatic provider refresh; return existing import/report metadata and an actionable import requirement instead of inventing new official data.
7. Return async refresh/investigation/export references and bounded poll/results rather than embedding huge exports. Continue complete queries through API cursors; expired/reset selections require explicit restart, not invisible dataset substitution.
8. Apply accurate tool annotations: purely saved reads are read-only; tools that create collection/investigation jobs are stateful even when they do not alter agents. Annotations do not replace API authorization.
9. Keep API concurrency/deadlines/output limits and cancellation end to end. Backpressure/throttling is actionable; do not fan out across all agents or loop indefinitely to return a tenant-sized tool result.
10. Add catalog/schema snapshots and synthetic tool tests spanning each family. Expose 03A audit origin/client/calling-agent/evidence fields and matching API filters without reinterpreting reported identities. Audited refresh/investigation/export calls carry 05's request-local descriptor automatically. Update integration docs with user/champion/trend and origin-filtering examples.

## Scope guard

No control execution until 07, generic SQL/KQL/HTTP tool, automatic refresh, scheduled task storage, new provider source, LLM inference code, or business aggregates outside the API.

## Validation

- Run `python -m pytest mcp/tests/test_read_tools.py mcp/tests/test_tool_catalog.py mcp/tests/test_api_client.py`.
- Verify actual catalog schemas/annotations and protocol `tools/list`/`tools/call`, not just direct Python calls.
- Exercise multi-page cohorts, every platform/report-only case, champions-only results, full description continuations, unknown/stale evidence, permission denial, cancellation, and no-provider-call saved reads.
- Capture method/path/normalized payload against the frontend operation map; prove shared defaults/results/errors for matched sources/users and API audit-origin evidence retained in MCP responses. Tool presentation may differ, not business meaning.
- Run the focused 04 API contract suite and configured Python static/type checks; use approved feeds only when installation is justified.
- Check documentation links and `git diff --check`.

## Production continuation

Apply README's Always-Deploy and accepted-Part-2 contracts. Distinguish API/tool correctness from live LLM answer quality. Carry real-client/model/source gaps to 09/12 with exact cases and bounded exposure; do not manufacture unsupported trends or use MCP implementation to bypass the earlier manual acceptance boundary.

## Completion record

Write `completions/06-mcp-read-tools.md`: catalog and API mapping, input/output/annotation contracts, full-text/pagination/provenance proofs, saved/live distinctions, test results, root impacts, and remaining client/provider cases.

## Done and handoff

07 can discover exact control targets through the same read contracts. 09 can execute every requested analytical prompt using protocol-level tools, with API-backed evidence and no hidden data joins or truncated completeness claims.
