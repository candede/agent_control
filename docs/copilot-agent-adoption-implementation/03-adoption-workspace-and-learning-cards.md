# 03 - Adoption workspace and learning cards

## Mission and prerequisites

Make AI recommendations usable inside the app: save/read/edit department briefs,
track staff actions, capture real workflow learning, and share only safe cards
with employees. Implement schema, API, MCP and browser contracts coherently.

Prerequisites: phases 01 and 02 and their exact completion records:
`completions/01-evidence-apis-and-mcp-reads.md` and
`completions/02-safe-discovery-and-agent-descriptions.md`. Read those,
campaign state, [README](./README.md), and [CONTRACT](./CONTRACT.md).

## Read first

- [Current schema](../../backend/src/db/currentSchema.ts),
  [operator/fingerprint](../../backend/scripts/database.ts),
  [guarded reset](../../backend/scripts/databaseReset.ts),
  [backup/restore owner](../../backend/scripts/backup.ts),
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
   Implement CONTRACT's persisted-content/evidence-lifetime rules: bounded
   API-derived aggregate baselines, durable evidence IDs/definitions and fresh
   per-caller reads, not stored cursors or a permanent participant registry.
2. Enforce CONTRACT's exact object authorization. Staff read tenant-shared
   content; creators/Admins edit core content/sharing/delete; assigned staff
   owners update their action progress/status. Assignment does not grant roles.
   EndUsers cannot write or read briefs/actions. Keep existing three app roles.
3. Provide finite typed list/detail/create/update/delete API operations and a
   compact MCP domain. Use current bearer/browser policies, idempotent create
   retry semantics, expected revisions on updates and genuine exact-target
   delete confirmation. Do not model a saved-card edit as a provider-control job.
   Bind retried creates to actual actor/request/payload identity; mismatched
   reuse conflicts. Lost outcomes remain unknown until resolved. Define minimal
   bounded deletion receipts so a delayed retry cannot recreate deleted content.
   Remove only an unavailable reference from independently owned linked records;
   do not cascade a parent delete into another author's content.
4. Validate generated content as untrusted input. Keep model suggestions separate
   from canonical facts; persist identity references rather than raw personal
   lists/contacts. Re-evaluate current privacy on reads, including changed flags
   after saving. Never trust model-supplied permissions, verified-link assertions
   or claimed successful-use metadata.
   Keep employee-safe slots separate from staff notes/raw generated narrative.
   Source regexes are not a general prose-safety guarantee: insufficient privacy
   evidence means explicit withholding, not an author-supplied approval flag.
5. Add an adoption workspace in the existing app with company/department/report
   context, evidence drilldowns, saved briefs, an action worklist and learning-card
   editor/list. Include useful empty, partial, stale, save-failed, conflict and
   unavailable states. Reuse API-calculated cohorts.
   Show baseline versus current group/window/coverage and cohort-drift warnings.
   Source correction/deletion/expiry must not silently rewrite saved evidence
   into a current fact or make a stored selection someone else's read authority.
6. Let a connected consumer save through MCP; let staff create/edit the same
   records through normal forms. Provide an honest "Copy analysis prompt" path
   for external-consumer handoff. Do not add a hosted model service or imply the
   browser/MCP server itself generates text.
   Copy durable requested source IDs/filter intent, never cookies, tokens or
   actor-bound selection/cursor values intended for reuse by another client.
   The consumer obtains its own authorized selections and reports expired intent.
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
   Visibility is exactly `staff_only` or explicitly `employees`, tenant-wide.
   Company/department labels are optional relevance filters, not audience ACLs;
   changing them cannot grant/revoke access or exclude a missing-profile member.
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
    Integrate backup/restore, source-clear/reference invalidation, principal
    revocation and tenant reset at their existing owners. Sign-out or another
    staff actor's session cleanup must not delete tenant-owned content; privacy
    deletion must remove private payload/references from reads and receipts.

## Focused verification

Add current-layout storage/SQL/route/UI/MCP tests. Required cases:

- Same-tenant cross-account sharing; cross-tenant denial; roleless read/write
  denial for staff records; creator, assignee and Admin field-level behavior.
- Idempotent retried creation; concurrent update conflict; exact delete;
  browser Origin/CSRF and bearer enforcement; malformed/oversized content.
- Same key/different payload and cross-actor replay; lost create response;
  delayed retry after deletion; linked action/card survival without private
  deleted content; storage/receipt accounting and bounded cleanup.
- Privacy changes after saving, hidden names in prose, inert malicious text,
  removed agent membership, employee-visible versus staff-only cards.
- Expired browser selections followed by MCP/app reload as another staff actor;
  deleted/corrected reports and expired Office evidence; unchanged saved aggregate
  baseline with explicitly changed follow-up membership/licensing/window.
- Tenant-wide employee sharing across departments, labels changed without
  authorization changes, roleless missing-profile search, unsafe arbitrary prose
  withheld rather than incorrectly declared redacted.
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

Add the focused content contract cases in planned
`backend/src/services/adoptionContent.unit.test.ts` and
`backend/src/routes/adoptionContent.unit.test.ts`, with storage/route SQL cases
in the existing DB test layout. Run the non-DB cases together:

```sh
npm run test --workspace backend -- src/services/adoptionContent.unit.test.ts src/routes/adoptionContent.unit.test.ts
```

Register the actual new SQL selectors in the existing `mcp-end-to-end` fixture
suite and run them through the isolated runner. Those are planned test files,
not existing implementation evidence. Typecheck is not write proof.

Run new DB-dependent tests in the isolated runner, not the live database.
From `mcp/`, combine new content cases with:

```sh
.venv/bin/python -m pytest tests/test_tools.py tests/test_workflows.py tests/test_audience_projection.py tests/test_discovery.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

Add `frontend/browser/adoptionWorkspace.spec.ts` in the existing browser layout
for workspace persistence, aggregate follow-up and safe-card handoff; extend
existing catalog/preview cases rather than adding another browser harness.
Check keyboard/focus, mobile widths, accessible labels and confirmation.
Do not repeat unrelated full suites after every edit.

## Production continuation

Obey [the binding production policy](./README.md#always-deploy-production-contract).
This phase proves schema/reset only in isolation; phase 06 executes the
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
