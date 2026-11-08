# 02 - Safe discovery and agent descriptions

## Mission and prerequisites

Make Microsoft and organization-created agents understandable and discoverable
through the appropriate staff and employee surfaces, with complete permitted
descriptions and truthful access/provenance. Implement the retrieval root cause,
not a prompt workaround.

Prerequisite: phase 01's contexts and representative fixtures. Read its actual
record `completions/01-evidence-apis-and-mcp-reads.md`, campaign state,
[README](./README.md) and [CONTRACT](./CONTRACT.md).

## Read first

- [Current discovery query](../../backend/src/db/agentDiscoveryQueries.ts),
  [source authority](../../backend/src/db/inventoryAuthority.ts),
  [discovery DTOs](../../backend/src/types/agentDiscovery.ts).
- [Saved-data discovery contract](../data-architecture.md#restricted-agent-discovery),
  [roleless-member policy](../user-roles-and-permissions.md).
- [Safe MCP DTOs](../../mcp/src/agent_control_mcp/discovery_models.py),
  [operations](../../mcp/src/agent_control_mcp/tools.py),
  [audience projection](../../mcp/src/agent_control_mcp/projection.py).
- [Discovery tests](../../mcp/tests/test_discovery.py),
  [safe DTO tests](../../mcp/tests/test_discovery_models.py),
  [audience tests](../../mcp/tests/test_audience_projection.py).
- [Observed description gap](../copilot-agent-adoption-intelligence/06-mcp-improvements-and-evidence-gaps.md#2-improve-safe-discoverys-description-and-first-party-coverage).

Trace the current discovery API, privacy renderer, About facts, canonical
memberships and first-party metadata before changing eligibility.

## Concrete work

1. Reproduce the controlled linked-agent case: staff About is available, but the
   employee-safe candidate has no native description. Record the exact source
   and privacy state; absence is not interchangeable with withholding.
2. Reuse complete Graph About for an exactly linked, independently verified
   organization-created canonical candidate whose native description is absent.
   Sharing/package presence alone must not make a package organization-created.
   Do not fall back around a privacy-withheld or unsafe field.
3. Add first-party Microsoft coverage for the supported discovery goal as a
   separately labelled origin, using authoritative saved publisher/package
   evidence. Do not relabel first-party agents as locally created or classify all
   shared packages as organization-created.
   Cover Graph-backed Agent Builder candidates when exact saved package/report/
   maker evidence establishes their organization-created origin, including
   Graph-only candidates. If necessary, repair the existing supported collection
   or normalization path for available evidence; do not invent a manual origin-
   approval flag or infer origin from names, sharing, or an ID prefix alone.
4. Preserve exact source memberships, full description continuation, safe
   provenance, privacy rendering and current-clock expiry checks. Do not copy
   descriptions into a second catalog/store.
5. Keep task matches as candidates, not proof of successful execution, personal
   entitlement, workbook access or a verified launch URL. Distinguish Microsoft,
   user-created and third-party origin without inferring Studio authorship from
   native inventory membership.
6. Update staff inventory follow-ups, employee catalog/detail/workplace,
   actual-user profile and staff EndUser preview consumers as implicated.
   Retain explicit subject-bound preview semantics; never borrow the subject's
   roles or combine privileged staff metrics into an employee response.
7. Preserve catalog-only discovery for roleless active members whose saved
   workplace is missing. No licensing, app-role, approved-card, manual-sync or
   capability-check prerequisite to already supported discovery.
8. Coordinate changed DTOs/paging/search fields across API, MCP, browser previews,
   tests and current reference docs. Delete any replaced source-selection logic
   rather than retaining a compatibility fallback. Leave the research report
   unchanged.

## Focused verification

Use shared fixtures for Microsoft/local and verified Graph-only Agent Builder
candidates, similarly named agents,
duplicate source records, a complete multi-segment About, missing versus
withheld descriptions, unknown publisher, expired authority, changed source
revision, unlicensed missing profile and all independent privacy flags.

Add backend query/service/route regression cases at the actual discovery owners.
Run those related selectors together with:

```sh
npm run typecheck --workspace backend
npm run test --workspace backend -- src/routes/mcpApiAuth.test.ts src/routes/mcpReadContracts.test.ts
```

Run database-dependent cases in the isolated stack. From `mcp/`:

```sh
.venv/bin/python -m pytest tests/test_discovery.py tests/test_discovery_models.py tests/test_audience_projection.py tests/test_tools.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

Required assertions: complete safe text is retrievable; provider origin stays
correct; hidden contact tokens do not reappear in snippets/pages/prose;
source loss invalidates access instead of returning stale complete evidence;
EndUsers cannot obtain staff evidence through any changed branch.

## Production continuation

Obey [the binding production policy](./README.md#always-deploy-production-contract).
Record real limitations and specific containment. Do not add a description
certification, first-party enable switch or adoption approval. Phase 07 owns the
live rollout; phase 06 owns integrated first-use proof.

## Completion and next phase

Write `completions/02-safe-discovery-and-agent-descriptions.md` and update campaign
state with CONTRACT's factual fields.

Done means the description/coverage changes are implemented and regression-tested
at the canonical owner, not merely documented. Phase 03 can reference current
safe canonical agents and reuse privacy rendering for shared learning cards.
