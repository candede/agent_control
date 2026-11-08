# 01 - Evidence APIs and MCP reads

## Mission and prerequisites

Implement the smallest canonical evidence surface that lets a connected AI
retrieve department activation opportunities without reconstructing Office
metrics or downloading whole people inventories. Implement code/tests/docs,
not another proposal. This phase has no prerequisites.

Read and obey [README](./README.md) and [CONTRACT](./CONTRACT.md) completely.
Create/update `completions/IMPLEMENTATION_CAMPAIGN.md` with the stable manifest,
prompt/contract hashes, actual roots/targets and phase state.

## Read first

- [API/MCP operation map](../mcp-reference.md#users-licensing-official-reports-cohorts-and-retained-history).
- [Office reads](../../backend/src/services/officeAppAdoptionReads.ts),
  [Office types](../../backend/src/types/officeAppAdoption.ts),
  [Office router](../../backend/src/routes/officeAppAdoption.ts).
- [Adoption groups](../../backend/src/services/adoptionGroups.ts),
  [departments](../../backend/src/services/adoptionDepartments.ts),
  [history](../../backend/src/services/adoptionHistory.ts),
  [paired relationships](../../backend/src/services/savedReadContracts.ts).
- [Report queries](../../backend/src/db/officialReportQueries.ts),
  [source authority](../../backend/src/db/inventoryAuthority.ts),
  [selection owner](../../backend/src/services/dataSelections.ts).
- [API route policy](../../backend/src/routes/policy.ts),
  [MCP access policy](../../backend/src/services/mcpAccess.ts),
  [native bindings](../../mcp/src/agent_control_mcp/tools.py),
  [typed domains](../../mcp/src/agent_control_mcp/domains.py),
  [inputs](../../mcp/src/agent_control_mcp/inputs.py).
- [Existing workflow corpus](../../backend/scripts/fixtures/mcp-workflows.json),
  [MCP feasibility tests](../../backend/src/routes/mcpContractFeasibility.test.ts),
  [Office read tests](../../backend/src/services/officeAppAdoptionReads.unit.test.ts).
- [Finance research example](../copilot-agent-adoption-intelligence/03-finance-activation-example.md).

Locate actual route registrations and consumers from these owners; do not treat
a guessed filename, DTO field, tool action or historical count as a contract.

## Concrete work

1. Establish a targeted baseline and one falsifiable hypothesis: a pinned exact
   department's Office-to-agent cohort can be retrieved through canonical
   calculations with explicit ambiguity/coverage, independent of provider-read
   permissions.
2. Bind existing Office context, summary/comparison, group/department, facet,
   people and history reads to a compact typed MCP domain. Extend the existing
   adoption domain for current HTTP-only summary/department/history reads.
   Reuse handlers/calculations, literal query/cursor semantics and frozen
   context. Do not introduce generic routes or a second Office owner.
3. Add one compact department opportunity API operation under the existing
   adoption route family and its MCP action. Use existing read/selection/SQL
   helpers. Its request pins the independent report, Office and inventory
   contexts; its output follows CONTRACT's department-evidence shape.
4. Calculate exact positive/no-reported/unknown agent evidence on the captured
   Office-paid audience. Report current directory/agent-paid denominators
   separately, without recasting historical eligibility. Return null/explicit
   unavailable where the evidence cannot establish a value.
5. Keep aggregate pages scalar and capped at ten groups/128 KiB. Supply bounded
   audience, peer and agent drilldowns using existing identities/read contracts.
   Preserve top-three champion edges rather than substituting department-wide
   agents; do not embed large descriptions or nested people in aggregates.
6. Wire policies, bearer admission, typed backend/Pydantic DTOs, domain
   registrations, actual metadata, API clients where affected, and operation-map
   documentation together. Retain current browser/MCP authorization and
   automatic authenticated entry.
7. Extend the existing shared synthetic workflow/SQL fixture with reusable
   controlled department evidence: duplicate department names across companies,
   exact and ambiguous identities, Office/report window differences, unknown
   Office evidence, overlapping reports, report-only agents and linked packages.
   A synthetic 22-paid/22-Office-active/7-definite-agent-user case must produce
   the exact 15-person opportunity only when every relationship is resolvable.
   Add ambiguity cases where that subtraction would be false.
8. Remove superseded declarations only if this phase replaces an existing
   current operation. No aliases, per-use-case tools, shadow summaries or schema
   compatibility scaffolding. Do not create saved briefs/cards yet.

## Focused verification

Add focused opportunity unit/SQL/route tests in the existing test layout. Verify
all scalar fields, denominators, selections, cursor continuation, source expiry,
mixed tenant/principal rejection, legitimate null filters, missing sources and
explicit limit errors. Prove weekly Office person reads stay aggregate-only.

Use the existing environment; representative commands from repository root:

```sh
npm run typecheck --workspace backend
npm run test --workspace backend -- src/services/officeAppAdoptionReads.unit.test.ts src/services/adoptionGroups.unit.test.ts src/services/adoptionDepartments.unit.test.ts src/routes/mcpContractFeasibility.test.ts
```

Combine newly added opportunity selectors in that runner. Run DB-dependent
cases only in the authorized isolated fixture environment.

From `mcp/`:

```sh
.venv/bin/python -m pytest tests/test_tools.py tests/test_report_models.py tests/test_workflows.py tests/test_service.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

If the local declared runtime is missing, record the failure and use/restore the
approved project environment, not a different Python version or public registry.
Measure page bytes and representative call count; final capacity owns scale.

## Production continuation

Obey [the binding production policy](./README.md#always-deploy-production-contract).
This phase changes source and isolated fixtures, not the live SEHA database.
Classify every required check truthfully with scoped residual handling; do not
make probe/check status or a future deployment record a prerequisite to reads.

## Completion and next phase

Write `completions/01-evidence-apis-and-mcp-reads.md` using CONTRACT's factual
record format, then update campaign state.

Done means actual authorized MCP evidence reads work, exact cohort calculations
and partial states are tested, current registrations/types/docs align, and the
shared representative fixtures exist. Phase 02 may rely on those contexts,
canonical references and fixtures, not on generated adoption advice.
