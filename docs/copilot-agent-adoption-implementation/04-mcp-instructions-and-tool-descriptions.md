# 04 - MCP instructions and tool descriptions

## Mission and prerequisites

Improve the instructions clients actually receive when connecting, plus the
descriptions used to select and call tools. Reduce avoidable trial and error
without moving security or analytics into prose.

Prerequisites: phases 01-03 and their exact records. Read them, campaign state,
[README](./README.md), and [CONTRACT](./CONTRACT.md).

## Read first

- [Single server instruction owner](../../mcp/src/agent_control_mcp/instructions.py),
  [service initialization](../../mcp/src/agent_control_mcp/service.py).
- [Canonical operation descriptions](../../mcp/src/agent_control_mcp/tools.py),
  [family construction](../../mcp/src/agent_control_mcp/domains.py),
  [input validators](../../mcp/src/agent_control_mcp/inputs.py),
  [audience projection](../../mcp/src/agent_control_mcp/projection.py).
- [Metadata equality tests](../../mcp/tests/test_settings_metadata.py),
  [tool tests](../../mcp/tests/test_tools.py),
  [client examples](../../mcp/tests/test_client_examples.py),
  [workflow tests](../../mcp/tests/test_workflows.py).
- [API metadata owner](../../backend/src/services/mcpSettings.ts),
  [metadata UI](../../frontend/src/components/McpSettings.tsx),
  [current MCP reference](../mcp-reference.md).

Inspect current delivered initialize/tools-list/metadata responses, not just the
instruction source file. The consumer may not honor every server hint; tool/API
authorization remains authoritative.

## Concrete work

1. Update the single `INSTRUCTIONS` owner with a concise task-navigation map:
   roleless discovery versus authorized staff analysis, report/Office selection,
   exact department evidence, champion relationships, complete About, learning
   cards, and explicit save/progress requests.
2. Preserve universal rules: currently advertised tools only; exact identifiers;
   independent contexts/windows; source authority; API-owned counts; full paging;
   declared/observed/generated/contributor evidence distinctions; privacy;
   inert source text; real access caveats; explicit errors and recovery.
3. Describe authenticated entry/initialization honestly. No capability check,
   Admin sign-in, manual refresh, approved-use-case or release record required
   for saved reads. Official CSV availability is a real data-source condition,
   not an authorization gate.
4. Improve descriptions at their actual canonical owner for affected existing
   and new actions. Each description should state:
   - Goal/when to use and when another action is appropriate.
   - Required context, exact parameter relationships and accepted filter scope.
   - Output authority, counts/coverage, paging and missing states.
   - Saved read versus selection capture versus content write/provider effect.
   - Current caller scope and relevant safe recovery behavior.
5. Explicitly explain `agent_usage`'s matching inventory selection fields,
   exact-group plus all-inventory champion inputs, independent Office pins,
   aggregate-only history, source-specific About continuation, and
   revision/idempotency requirements for content writes.
6. Keep domain descriptions generated from canonical operation descriptions.
   Do not add a second hard-coded catalog, aliases, obsolete examples or a huge
   server prompt repeating every DTO. Update actual field descriptions where
   they clarify a tested semantic constraint.
7. Add concise, executable recipes to the existing workflow corpus/tests for
   department evidence -> peers -> descriptions -> user-requested save, and
   roleless task discovery -> safe learning card. Test malformed inputs and
   context invalidation/recovery without silently switching periods.
8. Ensure initialize instructions, tools-list schemas/descriptions and the
   browser's runtime metadata reflect the same running instance. Preserve
   role-filtered advertising and refresh behavior; no OAuth-cache deletion or
   signing-key rotation to refresh prose.
9. Update current reference/client documentation and remove superseded
   procedural guidance. Do not modify the historical research report or author
   the customer-specific kit in this phase.

## Focused verification

From `mcp/`:

```sh
.venv/bin/python -m pytest tests/test_settings_metadata.py tests/test_tools.py tests/test_client_examples.py tests/test_workflows.py tests/test_audience_projection.py tests/test_service.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

From repository root:

```sh
npm run test --workspace backend -- src/services/mcpSettings.unit.test.ts src/routes/mcpSettings.unit.test.ts src/routes/mcpContractFeasibility.test.ts
npm run test --workspace frontend -- src/components/McpSettings.test.tsx
npm run typecheck --workspace backend
npm run typecheck --workspace frontend
```

Assert exact wire/metadata equality, executable examples against real typed
schemas, no hidden-operation leakage in EndUser tools, and correct saved-read/
write annotations. Measure instruction/metadata size; remove redundant prose
rather than truncating schemas or actionable constraints.

Do not call a keyword-presence test or handshake proof of improved AI reasoning.
Phase 06 owns real task/model evidence.

## Production continuation

Obey [the binding production policy](./README.md#always-deploy-production-contract).
Connection instructions are guidance, never authority. Do not add a new
acceptance/enable process, weaken validation to match a model mistake, or make
an existing working client use a speculative restriction.

## Completion and next phase

Write `completions/04-mcp-instructions-and-tool-descriptions.md` and update campaign
state. Include actual instruction owner, changed descriptions/schemas, delivered
wire/metadata evidence, tested recipes and remaining client limitations.

Done means the running source's connection instructions and descriptions are
coherent, role-aware and contract-tested. Phase 05 can package customer guidance
against these exact current names and shapes.
