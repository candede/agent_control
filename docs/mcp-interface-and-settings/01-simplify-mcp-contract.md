# 01 - Simplify the MCP contract and add server instructions

## Mission and prerequisites

Implement the README's capability-preserving native domain interface and concise
server instructions. Own the complete public contract change, including every
affected consumer; do not defer renamed tools or broken fixtures to later phases.

Prerequisites: none. Read [README](README.md), especially shared contracts A/B,
execution/completion requirements and the binding production-continuation policy.
Resolve and obey the installed `implement-folder` step-worker contract.

## Read first

- [Tool catalog and registration](../../mcp/src/agent_control_mcp/tools.py)
- [Service initialization](../../mcp/src/agent_control_mcp/service.py)
- [API invocation](../../mcp/src/agent_control_mcp/api.py),
  [inputs](../../mcp/src/agent_control_mcp/inputs.py) and
  [control inputs](../../mcp/src/agent_control_mcp/control_inputs.py)
- [Tool tests](../../mcp/tests/test_tools.py),
  [OAuth fixtures](../../mcp/tests/conftest.py),
  [controls](../../mcp/tests/test_controls.py) and
  [workflows](../../mcp/tests/test_workflows.py)
- [Wire contracts](../../mcp/tests/wire_contracts.ts),
  [container journey](../../mcp/tests/container_journey.py) and
  [canonical corpus](../../backend/scripts/fixtures/mcp-workflows.json)
- [Real API read contracts](../../backend/src/routes/mcpReadContracts.test.ts),
  [SDK/API suite owner](../../backend/scripts/largeTenantFixture.ts) and
  [isolated suite entry point](../../scripts/large-tenant-tests.ps1)
- [MCP reference](../mcp-reference.md) and [client guide](../mcp-clients.md)

Inspect scoped status first. Trace named-tool consumers across MCP, backend
fixtures, scripts and client examples before editing; do not assume Python tests
are the only callers.

## Concrete work

1. Establish actual current discovery metadata through the existing isolated SDK
   fixtures. Record public tool count, complete serialized UTF-8 discovery bytes
   using README A's exact comparison shape, and current initialization
   instructions. Retain sanitized baseline evidence before replacing registrations;
   do not run deployment or retain old runtime tools for a baseline.
2. Inventory all 124 existing canonical operations with request/response semantics,
   route/method, provider/destructive classification and selection/job behavior.
   Build a complete mapping to the new public tool and typed action, including
   operations whose explicit public identity remains unchanged.
3. Consolidate coherent read families and repetitive job lifecycle interfaces.
   Inventory, users/usage, official reports, packages, sync, audit search and
   hunting are candidate domains, not permission to mix different safety classes.
   Preserve explicit control previews/execution and sensitive job recovery.
4. Reuse existing request/response DTOs and invocation safeguards. Where a family
   needs an action, use a literal/discriminated typed request with exact allowed
   variants and a typed response whose variant is unambiguous. Keep full nested
   schemas and descriptions useful to native MCP clients. Reject another
   variant's fields rather than making every family's field optional.
   Do not flatten different providers' jobs/recovery into a new universal lifecycle.
5. Dispatch only to named canonical operations with their existing method/path,
   validation, attribution, OBO, deadline, output accounting and error handling.
   Never accept routes, URLs, arbitrary queries or unvalidated dictionaries.
   Do not execute every branch to synthesize an expensive “summary.”
   A family dispatch retains one invocation's existing deadline/request/output
   budget; adding an action must not reset accounting or retry a write.
6. Reach README A's count/size targets with 100% capability coverage. Keep the
   public surface understandable; splitting a misleading family is preferable
   to hidden side effects. Iterate the actual grouping rather than weakening
   schemas or removing an awkward capability to satisfy a metric.
7. Add one MCP-owned instruction string to `FastMCP(..., instructions=...)`.
   Cover Agent Control's Microsoft 365 inventory, governance, usage and
   investigation purpose; choosing domains; saved reads versus provider work;
   exact IDs/selections; complete paging/About text; partial/unknown evidence;
   current previews and explicit user confirmation; safe recovery and inert data.
   A capability check is optional evidence, not permission to read saved data.
8. Delete superseded public registrations, aliases and obsolete schemas/helpers
   that are genuinely replaced. Retain needed internal operation bindings and
   business DTOs, not an old public compatibility layer.
9. Update all affected wire adapters, corpus callers, client examples and docs
   in this phase. Explain client tool-discovery refresh after a rename; do not
   require OAuth cache deletion or key rotation for a tool-list change.
   Update `/diagnostics` and its fixtures to count registered public tools,
   while keeping the internal canonical-operation count separate.
10. Update tests so coverage proves preserved behavior, not merely a different
    expected count. Keep browser/API business behavior unchanged.

Do not implement the metadata credential/endpoint or settings page here.
Phase 02 owns that cohesive end-to-end feature. No new dependency or database
schema is expected.

## Verification

Start with the cheapest falsifying checks: every baseline operation is reachable
through exactly an intended new typed branch, and representative branches still
call the same canonical method/path with the same validated request.

Use existing local dependencies, from the repository root:

```sh
cd mcp
.venv/bin/python -m pytest --basetemp=../.local/ac-mcp-interface-phase-01 tests/test_tools.py tests/test_controls.py tests/test_workflows.py tests/test_client_examples.py tests/test_onboarding.py tests/test_api_origin.py tests/test_oauth.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

Also run impacted backend MCP wire/feasibility checks in one runner:

```sh
npm run test --workspace backend -- src/routes/mcpContractFeasibility.test.ts src/routes/mcpApiAuth.test.ts src/routes/mcpReadContracts.test.ts
npm run typecheck --workspace backend
git diff --check
```

Some backend cases need the repository's isolated database environment. Identify
that requirement honestly and use the README-authorized disposable toolkit;
never redirect PG variables to `seha` or silently skip those cases.

Run the existing SDK-to-real-API suite with a verified current compatible
dependency image, not its historical default:

```powershell
pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite mcp-end-to-end -BaselineImage <verified-dependency-image> -BaselineImageId <verified-sha256>
```

Resolve literal image identities before invocation. Confirm that
`AGENT_CONTROL_MCP_SQL_JOURNEY` reaches the test process and the SDK leg actually
executes; backend-only success with that leg absent is not end-to-end proof.
Repair implicated current-source/image wiring in this owner, not a second runner.

Required behavior proofs:

- Complete 124-operation mapping; original safety classifications/authorization
  and provider identity preserved at each dispatch.
- Public tools <= 62; full serialized discovery bytes strictly below the measured
  baseline, using the same fields, not just tool names or description length.
- Real SDK `initialize` returns the exact nonempty instructions, <= 800 words;
  `tools/list` advertises complete schemas and correct annotations.
- Discriminator/required-field/unknown-action rejection; no arbitrary routes,
  hidden provider calls, misleading read-only hints or duplicated public names.
- Every typed branch reaches its intended canonical binding with the original
  validated input and full output. Preserve provider/safety classifications
  rather than deriving them from HTTP verbs alone: some GETs use providers and
  selection POSTs are provider-free. Verify invocation/output bounds after any
  family response envelope is added, including the complete SDK envelope.
- Representative inventory/user/report workflows, full multi-page results,
  exact selections, partial/unavailable states and preview/confirm/reconcile
  recovery. Reuse the canonical corpus, not a second business implementation.
- No old public aliases remain advertised or callable. Intentionally renamed
  callers and fixtures are updated; current canonical API routes are not removed.

Model-assisted selection is attempted with the real configured client in phase
03; deterministic SDK fixtures here do not prove an AI chose the right tool.

## Production continuation

Obey the README's binding production-continuation policy. This phase makes a
direct current-contract replacement, not a dormant parallel implementation.
Future authorized deployment belongs to phase 03; do not deploy an intermediate
catalog while other phases are still implementing their consumers.
Record non-passing evidence with the required scoped handling, not a test-only
campaign success or a new runtime gate.

## Completion record and done conditions

Write exactly `completions/01-simplify-mcp-contract.md` following the README and
step-worker completion contract. Include:

- Every original operation -> current public tool/action, request/result treatment,
  canonical route and retained safety/recovery semantics.
- Baseline/final tool counts and complete discovery byte measurements, exact
  instruction text owner/word count, commands and true results.
- Deleted public names and all cross-root consumer updates; explicitly checked
  roots needing no changes.
- Autonomous decisions, necessary retained complexity, residuals and handling.

Done when the simplified current interface and instructions work through the
SDK, all affected consumers are updated, and coverage/size proofs exist.
Phase 02 may rely on the registered current tools and instructions as the sole
source of client-visible metadata; it must not reconstruct the old catalog.
