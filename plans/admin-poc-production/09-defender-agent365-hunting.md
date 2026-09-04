# Phase 09 - Defender and Agent 365 Hunting

## Mission

Integrate Microsoft Graph advanced hunting for Defender XDR and Agent 365, normalize preview `AgentsInfo` inventory and Agent 365 `CloudAppEvents` observability, and expose bounded security investigation without representing telemetry as official usage.

## Prerequisites

- Read the roadmap and completion records for Phases 01-08.
- Graph delegated/application auth, capability gates, durable jobs/observations/checkpoints, normalized identities, and security-audit UI contracts must exist.
- Do not deploy in this phase.

## Read first

- Phase 02 auth/capability code
- Phase 04 normalized identity resolver
- Phase 07-08 audit projections and security UI
- Current Graph v1.0 `security/runHuntingQuery` documentation
- Current Defender XDR advanced hunting API limits/RBAC documentation
- Current `AgentsInfo` and `CloudAppEvents` table references
- Current Agent 365 observability concepts and attribute reference

## Permission contract

- Endpoint: `POST https://graph.microsoft.com/v1.0/security/runHuntingQuery`.
- Delegated and application permission: Microsoft Graph `ThreatHunting.Read.All`.
- Delegated results are additionally constrained by Defender XDR unified RBAC and the data sources/device groups assigned to the signed-in user. A token scope alone does not establish access.
- Application access depends on tenant consent, Defender deployment, supported data sources, and licensing.
- `AgentsInfo` is preview. Do not use the retired `AIAgentsInfo` name.
- `CloudAppEvents` requires Defender for Cloud Apps/Microsoft 365 activity connectivity. Agent 365 events require onboarded telemetry and at least one assigned Microsoft 365 E7 or Microsoft Agent 365 license where the current service contract requires it.

## Required implementation

1. Implement a typed `runHuntingQuery` adapter with request timeouts, response-schema validation, documented quota/size handling, bounded retries for safe failures, and correlation IDs. Parse `schema` and dynamic results without trusting result field types blindly.
2. Add a curated `AgentsInfo` snapshot query with explicit projection and limits. Normalize all documented fields: agent/source/Entra/blueprint IDs, platform, name/description/version, auth, requested/granted permissions and consent state, publish/lifecycle/availability, dates, owners/sharing, instances, instructions, model, channels, capabilities, data sources, tools, MCP servers, skills, connected agents, memory, triggers, guardrails, endpoints, observability ID, and bounded raw data.
3. Mark `AgentsInfo` and individual preview fields as preview. Preserve null versus empty versus unavailable. Treat Defender lifecycle and permission observations as another source; do not overwrite Graph package or Power Platform states.
4. Link Defender agents only with exact `AgentId`, `SourceAgentId`, Entra app/enterprise-application identifiers, `EntraBlueprintId`, `ObservabilityId`, or reviewed links. Keep object IDs and app IDs as distinct identifier kinds.
5. Add curated `CloudAppEvents` queries for Agent 365 operations and security pivots. Normalize invocation, inference, tool execution, conversation/session, user/account, channel, agent/blueprint/platform, source/target agent, action, timestamps/duration, client/server, error, model/provider/token count, tool, correlation, and report identifiers when exposed.
6. Respect the current Agent 365 exposure contract: several emitted attributes, including input/output messages and tool arguments/results, can be accepted downstream but are not exposed in advanced hunting. Display `Not exposed by Defender hunting`; never infer absent content.
7. Treat an Agent 365 run as visible to admin/Defender activity views only when a valid root `invoke_agent` span exists. Child-only events may be queryable but do not prove the admin-center run exists.
8. Add an on-demand investigation view with fixed templates, time ranges, normalized filters, schema/result preview, export, and links to agent detail. Access requires `AgentControl.SecurityReader`; execution and export are audited.
9. Add an advanced KQL mode only behind explicit configuration and `AgentControl.Administrator` plus `AgentControl.SecurityReader`. Clearly state its broad data reach, enforce provider timespan and response limits, reject multiple/management commands, audit query hash plus actor (not sensitive result content), and default it off.
10. Add optional application-owned scheduled snapshots for `AgentsInfo` and bounded Agent 365 activity summaries using the durable lease/checkpoint stack. Preserve raw event retention policy and avoid permanent full-table harvesting by default.
11. Add observability readiness diagnostics: Agent 365/Defender license/rollout, Cloud Apps connector, table existence, latest matching event, root-span availability, and exact IDs needed for correlation. An empty query is `no_data`, not automatically `missing_permission`.
12. Surface Agent 365 write-onboarding guidance without impersonating external agents. Explain that the emitting agent's own identity must receive `Agent365.Observability.OtelWrite` on resource app ID `9b975845-388f-4429-889e-eab1ef63949c`, its URL `{agentId}` and payload ID must match its token, requests are limited to 1 MB, and HTTP 200 can contain rejected spans. Agent Control does not emit fabricated activity for managed agents.
13. Keep official usage, Purview audit, Defender hunting, and telemetry summaries visibly separate. Cross-source comparison may show counts side-by-side only with source, time window, coverage, and non-equivalence labels.

## Focused validation

- Adapter tests for delegated/application tokens, 401/403/RBAC ambiguity, timeout, throttling, API error, dynamic schema typing, malformed rows, quota/result truncation, and empty valid results.
- `AgentsInfo` fixture tests for every documented identifier/field, preview/null states, app ID versus object ID, lifecycle disagreement, unknown fields, and deterministic snapshot projection.
- `CloudAppEvents` tests for all Agent 365 operation types, root/child spans, alternate platform IDs, agent-to-agent callers, absent non-exposed content, errors, token strings, and exact identity links.
- Security tests for curated filters, advanced-mode off/default, role combination, unsafe KQL forms, query/export auditing, raw retention, and log redaction.
- UI tests for permission/RBAC/license/connector/no-data distinctions, preview states, source labels, investigation pivots, and responsive dynamic results.

## Aggregate validation

Run the global validation baseline. With an authorized tenant, issue one bounded `AgentsInfo` query and one narrow `CloudAppEvents` query. Empty results are acceptable; prove contract and diagnostics without persisting tenant-sensitive examples.

## Production continuation

License, RBAC, table rollout, or empty telemetry does not stop the campaign. Disable only the affected hunting path, preserve other authorities, show exact remediation/evidence, and carry the result. Do not add permissions outside `ThreatHunting.Read.All` to chase missing data.

## Scope guard

Do not emit telemetry for external agents, create Defender detections/incidents, quarantine agents, ingest transcripts, or convert hunting counts into official usage. Do not deploy.

## Completion record

Create `plans/admin-poc-production/completions/09-defender-agent365-hunting.md` with query templates, field/identity coverage, delegated/application/RBAC evidence, preview limitations, and Phase 10 preconditions.

## Done conditions

- Defender/Agent 365 inventory and activity are safely queryable and source-provenanced.
- Exact identities enrich normalized agents without overwriting other providers.
- RBAC, licensing, onboarding, empty data, and non-exposed content are truthfully distinguished.
- Hunting and telemetry are never labeled official usage or Purview audit.
