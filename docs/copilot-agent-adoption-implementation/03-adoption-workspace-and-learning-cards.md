# 03 - Adoption workspace and learning cards

## Mission and prerequisites

Make AI recommendations usable inside the app: save/read/edit department briefs,
track staff actions, capture real workflow learning, and share only safe cards
with employees. Implement schema, API, MCP and browser contracts coherently.

Prerequisites: phases 01 and 02 and their exact completion records. Read those,
campaign state, [README](./README.md), and [CONTRACT](./CONTRACT.md).

## Read first

- [Current schema](../../backend/src/db/currentSchema.ts),
  [operator/fingerprint](../../backend/scripts/database.ts),
  [guarded reset](../../backend/scripts/databaseReset.ts),
  [reset procedure](../operations.md#reset-application-data).
- [Route policy](../../backend/src/routes/policy.ts),
  [actual-principal access](../../backend/src/services/mcpAccess.ts),
  [roles](../user-roles-and-permissions.md).
- [App shell](../../frontend/src/App.tsx),
  [API client](../../frontend/src/api/client.ts),
  [frontend authorization](../../frontend/src/authorization.ts),
  [responsive styles](../../frontend/src/App.css).
- [MCP operations](../../mcp/src/agent_control_mcp/tools.py),
  [domain schemas](../../mcp/src/agent_control_mcp/domains.py),
  [safe discovery models](../../mcp/src/agent_control_mcp/discovery_models.py).
- [Existing safe-discovery architecture](../data-architecture.md#restricted-agent-discovery).

Resolve current storage accounting, scoped deletes, error handling, confirmation,
CSRF and UI form/list patterns; reuse them rather than inventing a content CMS.

## Concrete work

1. Implement the minimum current-schema storage for typed briefs, learning cards
   and actions. Use tenant ownership, creator/assignee references, bounded
   structured payloads, source-context references, revisions and timestamps.
   No copied telemetry, generic knowledge warehouse, duplicated champion store,
   approval state machine or background campaign engine.
2. Enforce CONTRACT's exact object authorization. Staff read tenant-shared
   content; creators/Admins edit core content/sharing/delete; assigned staff
   owners update their action progress/status. Assignment does not grant roles.
   EndUsers cannot write or read briefs/actions. Keep existing three app roles.
3. Provide finite typed list/detail/create/update/delete API operations and a
   compact MCP domain. Use current bearer/browser policies, idempotent create
   retry semantics, expected revisions on updates and genuine exact-target
   delete confirmation. Do not model a saved-card edit as a provider-control job.
4. Validate generated content as untrusted input. Keep model suggestions separate
   from canonical facts; persist identity references rather than raw personal
   lists/contacts. Re-evaluate current privacy on reads, including changed flags
   after saving. Never trust model-supplied permissions, verified-link assertions
   or claimed successful-use metadata.
5. Add an adoption workspace in the existing app with company/department/report
   context, evidence drilldowns, saved briefs, an action worklist and learning-card
   editor/list. Include useful empty, partial, stale, save-failed, conflict and
   unavailable states. Reuse API-calculated cohorts.
6. Let a connected consumer save through MCP; let staff create/edit the same
   records through normal forms. Provide an honest "Copy analysis prompt" path
   for external-consumer handoff. Do not add a hosted model service or imply the
   browser/MCP server itself generates text.
7. Capture task, prompt pattern, inputs, expected output, review steps, known
   failures, appropriate anonymized examples and optional outcome evidence.
   Distinguish generated drafts from contributor-provided/confirmed workflows.
   Do not collect private prompts/conversations or infer actual workflows from
   response counts.
8. Implement employee-shared card retrieval through the existing finite
   discovery service and suitable catalog/workplace/detail surfaces. Return
   only safe fields; exclude staff metrics, private references, hidden contacts
   and action data. Sharing is an author visibility choice, not certification.
   A missing profile must still allow permitted organization-wide card search.
9. Revalidate agent source/privacy evidence on shared-card reads. If an agent's
   current evidence is unavailable, disclose that state; do not fabricate
   current availability or silently attach another similarly named agent.
10. Wire types, grants, schema fingerprint, storage cleanup/accounting, current
    API docs, browser navigation and MCP metadata together. Remove any
    superseded implementation in this owner. Schema change uses current-schema
    initialization and a justified reset, not compatibility migrations.
    Update the existing role/permission documentation for these new content
    operations and assert that the Entra app-role manifest still has exactly the
    same three roles and identifiers.

## Focused verification

Add current-layout storage/SQL/route/UI/MCP tests. Required cases:

- Same-tenant cross-account sharing; cross-tenant denial; roleless read/write
  denial for staff records; creator, assignee and Admin field-level behavior.
- Idempotent retried creation; concurrent update conflict; exact delete;
  browser Origin/CSRF and bearer enforcement; malformed/oversized content.
- Privacy changes after saving, hidden names in prose, inert malicious text,
  removed agent membership, employee-visible versus staff-only cards.
- Empty workspace before sync/report import; create/edit/reload/assign/progress;
  interrupted save, explicit notification and preservation of unsaved inputs.
- Fresh schema, grants and reset initialization with new content objects;
  mismatch produces the existing honest reset-required path.

Run focused new selectors with:

```sh
npm run typecheck --workspace backend
npm run typecheck --workspace frontend
npm run test --workspace frontend
```

Run new DB-dependent tests in the isolated runner, not the live database.
From `mcp/`, combine new content cases with:

```sh
.venv/bin/python -m pytest tests/test_tools.py tests/test_workflows.py tests/test_audience_projection.py tests/test_discovery.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

Add focused browser coverage for the new workspace and safe-card handoff.
Check keyboard/focus, mobile widths, accessible labels and confirmation.
Do not repeat unrelated full suites after every edit.

## Production continuation

Obey [the binding production policy](./README.md#always-deploy-production-contract).
This phase proves schema/reset only in isolation; phase 07 executes the
authorized live reset if required. Record expected loss of old business data
and genuine CSV reimport needs. Do not add a role, approval process, manual
initial sync or card-publication requirement to existing supported discovery.

## Completion and next phase

Write `completions/03-adoption-workspace-and-learning-cards.md` and update campaign
state. Include exact new record/authorization/revision contracts, reset rationale,
shared-card privacy behavior and all changed API/MCP/browser surfaces.

Done means real records survive reload and concurrent updates behave honestly,
the same authorized record is accessible through UI and MCP, safe cards reach
EndUsers without staff leakage, and current fresh initialization is proved.
Phase 04 may describe actual implemented read/write operations, not planned ones.
