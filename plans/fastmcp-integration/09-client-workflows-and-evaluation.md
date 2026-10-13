# 09 - Client onboarding and prompt evaluations

## Mission

Provide tested client onboarding and synthetic prompt workflows that exercise the actual MCP tools, including interactive confirmation, externally scheduled execution, use-case reasoning, and honest trend limitations.

## Prerequisites

Read [README](README.md), [06](06-mcp-read-tools.md), [07](07-mcp-agent-controls.md), [08](08-local-container-integration.md), and their completion records. Inspect actual catalog/schemas/endpoint rather than relying on draft examples.

## Read first

- Integration/setup/operations docs and catalog/configuration produced in 05-08.
- [Champion semantics](../../backend/src/services/adoptionGroups.ts), [usage constraints](../../docs/official-usage-import.md), [security boundaries](../../docs/security-model.md).
- Verify current primary onboarding/auth/transport documentation for Copilot Studio, Microsoft 365 agent publishing, VS Code/GitHub Copilot, Claude remote MCP clients, and refresh behavior in cowork scheduling. Treat unsupported client editions/versions explicitly.

## Required implementation

1. Create `docs/mcp-client-setup.md` with exact Streamable HTTP URL/discovery/registration/scopes/callback steps per supported client. Distinguish Copilot Studio connection tests from publishing a Microsoft 365 Copilot agent. Do not assume one client supports another's auth/prompt/resource features.
2. Document generic customer-agent/cowork connection and scheduled delegated authorization: external scheduler, initial OAuth consent, refresh, expiry/Conditional Access recovery, and result/error handling. No app-side scheduled task implementation.
3. Provide ordinary text workflow recipes, not VS Code agent customization files: identity/data readiness; full pagination; full About retrieval; exact used/created relationships; champion query; evidence-backed trends; interactive and scheduled controls.
4. Interactive recipes require an exact preview and explicit confirmation before each target block. Changed/expired previews require fresh display and confirmation. Scheduled recipes may evaluate descriptions, obtain current receipts, and execute without a human pause; no added API approval policy.
5. Make confirmation ownership transparent: MCP annotations/instructions do not prove human consent, and a generic external client can call execute directly with a valid receipt. Never advertise a server-enforced human-confirmation guarantee.
6. Build a versioned synthetic fixture corpus covering native/guest users, company/department champions versus other people, multiple platform types, all inventory scopes, report-only rows, duplicated names, full descriptions, missing/stale sources, report overlap/unknown periods, and autonomous description-based target choice.
7. Implement README acceptance cases A-C using 01's exact synthetic inputs/expected IDs, plus valid/invalid trends. Do not rely on unspecified historical prompts. Check observable tool calls/results and final answer claims: exact IDs, counts, relationships, citations/source references, complete pagination, full descriptions, missing evidence, platform effects, confirmation pause, scheduled no-pause, and verified versus merely accepted status. Reuse one corpus for deterministic, repeated real-model and production qualification.
8. Include adversarial source descriptions that try to change tool behavior; they remain inert evidence. Test denial, claims challenges, revocation, changed targets, partial failures, and reauthentication without a service-account fallback.
9. Implement deterministic protocol/fixture evaluation and attempt actual client/model runs against synthetic endpoints/data. Report deterministic, SDK, real-client, and real-model results separately with versions/transcripts redacted. No paid third-party model/service provisioning or confidential source/data sharing without explicit approval.
10. Repair reproducible prompt/tool/API root defects in their owners and update completion contracts. Do not compensate with client business calculations. Shared API/web changes follow README's Part 1 root repair, redeployed web validation and material-change reacceptance rule; adding MCP is not authorization to redesign accepted routes or web behavior.
11. Document per-client attribution support and evidence: what OAuth/clientInfo/request metadata exposes, whether a cowork/Copilot Studio agent can supply its ID/name, and which fields remain reported/unknown. Provide examples for the same admin acting through Web app, MCP/Claude Cowork, and MCP/calling agent; do not promise authenticated agent identity or infer it from conversation text.
12. Add paired web/MCP scenarios capturing identical canonical API methods/routes/business inputs and comparing business results, provider effects, and errors under the same user/source/prestate. Check that only legitimate transport/provenance fields differ and that the web audit UI/filter/details/CSV and MCP audit tools retain exact origin/evidence.

## Scope guard

No server LLM, designated champion groups, agent prompt/customization-file campaign, new business approval gate, hidden transcript collection, customer scheduling engine, or live bulk mutation.

## Validation

- Add `mcp/tests/test_prompt_scenarios.py` and synthetic fixtures; run it with catalog/read/control protocol suites.
- Attempt onboarding/initialization/tool invocation/refresh for each target client using approved local or HTTPS test connectivity. A loopback endpoint does not prove remote Copilot/Claude reachability; absent approved ingress stays `unavailable`, with no auto-tunnel/public exposure. Missing clients/accounts are `unavailable`, not passed.
- Attempt repeated synthetic real-model scenarios where an approved client/account is available; retain case-level errors/distribution rather than one favorable transcript.
- Verify actual interactive execution pauses and actual scheduled execution does not; do not infer either from a docstring.
- Exercise spoofed Web app/MCP/agent labels, absent agent metadata, simultaneous client sessions and agent invocations, asynchronous completion, cross-client idempotent replay, and resumer-origin separation. Client-name availability is not verified vendor attribution.
- Validate documented settings against deployed/local configuration, links, configured Python checks, and `git diff --check`. Honor README feeds.

## Production continuation

Apply README's Always-Deploy and accepted-Part-2 contracts. Inaccessible clients/models produce exact residual cases and 12 observation obligations. Preserve the accepted web baseline; do not open unsafe tools, bypass acceptance, or claim all clients supported from deterministic fixtures alone.

## Completion record

Write `completions/09-client-workflows-and-evaluation.md`: client/version/auth/attribution-support matrix, shared-route parity and origin scenarios, recipes, corpus version, expected/measured behavior, scenario-level results, confirmation/attribution limitations, root repairs, residual containment/canaries, and production publishing/onboarding actions.

## Done and handoff

Every agreed prompt has an executable fixture and a client workflow. All target clients have explicit setup and truthful attempted evidence. 10 knows callback/ingress requirements; 11/12 have exact remaining client/model proof obligations.
