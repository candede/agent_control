# 02 - Agent configuration and verified dependencies

Reasoning posture: extra-high. Read the roadmap, phase 01 completion and campaign parent decisions.

## Outcome

An agent's Overview clearly answers configured connectors/operations, explicitly established flow relationships, responsible people, environment, and configuration. Activity and Manage remain the actionable agent-scoped surfaces.

## Implementation

1. Carry useful environment metadata from the same authorized saved scope to the unified agent contract. Include identity/name, region/type and useful managed-environment facts with observation provenance and unknown states. Avoid a new environment catalog endpoint or exposing unrelated environments.
2. Replace noisy generic metadata references with a purposeful configured-capabilities presentation. Show connector IDs and configured operations, usage as tool/topic-tool/knowledge, enabled state, end-user consent, connection provider and invocation conditions when supplied. Preserve exact counts separately from bounded details; preserve false and zero.
3. Review published Microsoft schema for connector-operation configuration/creator metadata. Keep only justified minimised fields and source provenance. Do not retain connection credentials/callback secrets. Do not promote arbitrary recursive metadata strings or URL hosts to verified configured services.
4. Implement flow context strictly from an established documented contract. Parent source-research decisions in campaign state are binding. If existing sources do not expose an invoked-flow relationship, show that precise limitation and an official-console handoff on the agent, not an empty confirmed flow list or an invented `flowIds`/`flows` payload. Do not blanket-query flow inventory to guess relationships. Any actual explicit relation path must be wired ingestion -> persistence -> authorized agent response -> UI -> tests, support shared flows and bounded partial states.
5. Structure the Overview around responsibility, environment and configuration/capabilities while keeping technical IDs/provenance under disclosure. Source-only and sparse agents must still be useful without duplicating unavailable generic tabs.
6. Preserve and contextualize existing Owner/Created by/Last modified by. Do not describe a last modifier as the current maintainer or infer permission from ownership.
7. Provide validated official Microsoft console links where the source supports an exact agent/environment target; otherwise an honestly labelled console landing link. Build URLs from allowlisted official origins and validated IDs, never arbitrary provider URLs.
8. Keep exact package version selection, management gating, quarantine freshness, usage context and saved activity behavior. No provider reads on ordinary saved-data browsing.
9. Update agent export where additional context is relevant and safe, with consistent labels/counts/provenance. Document source limitations and how to read configured versus observed usage.

## Verification and handoff

Cover complete, missing, explicit empty, partial, malformed and oversized capability metadata; disabled/consent booleans; same-name/same-environment non-relations; shared explicit dependencies if supported; environment scope/freshness; graph-only and PP-only agents; links and mobile layout. Use existing unit/browser machinery and fixtures with no live credentials.

Run focused parser/repository/unified-agent/export/frontend tests and build/typecheck/lint. Create `completions/02-agent-resource-context.md`, including exact source evidence and any genuine unavailable provider information. Phase 03 must be able to link responsibility identities to canonical agent records without conflating usage.
