# 02 - Current discovery schema and safe canonical API

## Mission and prerequisites

Implement evidence-backed employee discovery using shared saved data and
positive allowlist contracts, not adoption/admin DTOs. Reuse these same reads
for an explicitly authorized staff preview of another stored member account.
Own the best-fit current schema for these queries and its clean-reset contract.
Existing data/layout need not survive; source ownership, authentication,
privacy and supported staff behavior must.
Prerequisite: phase 01 and `completions/01-roleless-discovery-authority.md`.

Read and obey [README](README.md), especially contracts C/D/E/F and the binding
always-deploy production contract. Read the installed implementation/worker
contracts and current campaign record before editing.

## Read first

- [Phase 01](01-roleless-discovery-authority.md) and its completion record,
  including the implemented identity/access-profile and first-run contracts.
- [Inventory queries](../../backend/src/db/inventoryQueries.ts),
  [authority SQL](../../backend/src/db/inventoryAuthority.ts),
  [selections](../../backend/src/services/dataSelections.ts),
  [inventory selection ownership](../../backend/src/db/inventorySelections.ts).
- [Adoption groups](../../backend/src/services/adoptionGroups.ts),
  [report reads](../../backend/src/services/largeTenantUsersReports.ts),
  [official queries](../../backend/src/db/officialReportQueries.ts),
  [user sources](../../backend/src/db/userSources.ts),
  [adoption types](../../backend/src/types/adoption.ts).
- [Agent presentation](../../backend/src/types/agentPresentation.ts),
  [inventory types](../../backend/src/types/unifiedAgents.ts),
  [package descriptions](../../backend/src/types/copilotPackage.ts),
  [saved-read contracts](../../backend/src/types/savedReadContracts.ts),
  [route policy](../../backend/src/routes/policy.ts) and
  [API assembly](../../backend/src/app.ts).
- [Existing scale fixture](../../backend/scripts/largeTenantFixture.ts),
  [MCP workflow corpus](../../backend/scripts/fixtures/mcp-workflows.json),
  [test entry point](../../scripts/large-tenant-tests.ps1) and
  [current schema](../../backend/src/db/currentSchema.ts),
  [schema verification](../../backend/src/db/schema.ts),
  [database operator](../../backend/scripts/database.ts),
  [reset owner](../../backend/scripts/databaseReset.ts),
  [deployment lifecycle](../../scripts/local-runtime.ps1) and
  [reset runbook](../operations.md#reset-application-data).
- [Organization-created classification](../../backend/src/types/agentPresentation.ts),
  [inventory publication](../../backend/src/db/inventoryGenerations.ts) and
  [directory publication](../../backend/src/db/userSourceStages.ts).

## Concrete work

Before implementing the reads, settle their current schema and query shapes
against README's approved reset decision. Use existing source/report authorities,
but do not preserve unsuitable tables, JSON layouts or indexes for compatibility.
Choose typed fields/relationships, constraints and access paths for:

- current organization-created canonical agents, complete purpose descriptions
  and safe continuation, with source/revision/expiry provenance;
- exact tenant-local directory identity and stored company/department scope;
- deduplicated person-agent report relationships pinned to one report lineage;
- actor-owned selections with validated subject/mode/profile query bindings.

Reuse suitable structures rather than rewriting the whole database. Any derived
search text/index belongs to canonical publication and is rebuilt with the same
revision; it is not a second data owner. Compare actual plans for existing and
proposed query shapes at the README scale before retaining extra indexes or
materialization. Own changed producers, consumers, schema verification/grants,
fixtures, retention/removal and stale-source invalidation together. Delete
superseded structures and queries; keep only the resulting current schema.
Preserve supported staff wire behavior while replacing storage; update its
readers and tightly coupled frontend/MCP types/tests in this phase where affected.
Phase 03 owns the new employee/preview MCP bindings, not deferred storage repairs.
Record the final query-to-storage/index/owner map in this phase's completion,
not a separate design framework. No data migration or old-schema runtime.

1. Define typed safe profile, catalog card/detail, department champions,
   department use-case and department/company popularity responses. Use positive SQL
   projection and DTO allowlists. Test a seeded full source record containing
   every forbidden metric/admin/private field before wiring MCP.
   Implement the API-owned conditional safe projection from README contract C
   for both privacy booleans. Apply it to every self-service and staff-preview
   output before it reaches MCP/AI, even when a staff actor calls the ordinary
   employee discovery endpoint. Do not rely on client instructions or UI hiding.
2. Add finite canonical discovery reads with the phase 01 policy. Own the
   profile/self-champion answer, organization search/detail and own-department
   champions/use-cases plus department/company popularity. Add a typed staff-only
   preview entry point that resolves an exact stored same-tenant active member
   and invokes those same services/DTOs with a validated subject context.
   No duplicated preview SQL, copied employee implementation or session switch.
   Keep the authenticated actor immutable and clearly label preview/subject.
   Labels must not reintroduce a hidden owner/champion identity; use neutral
   preview/subject context and permitted workplace fields where needed.
   Reuse existing selection capture and cursor
   semantics; expose any necessary provider-free capture as a typed operation,
   not a new context database. Record exact methods/routes/inputs/outputs for
   phase 03 in this phase's completion record.
3. Default to current saved inventory and the API-owned Latest retained complete
   report by content period; superseded correction originals are not Latest
   candidates. Run existing report-history retention preparation automatically
   before capturing new discovery selections, including catalog-only reads.
   Pin complete identities/revisions across each answer and continuation.
   Do not sum overlapping report periods, change anyone's personal report
   preference, write a tenant selected-period setting or require an employee
   to choose a report before asking a question.
4. Search approved names and full business-purpose descriptions across all
   saved organization-created agents, including private/draft records.
   Use current `organization_created` evidence rather than the broad
   organization/deployed/used view; test shared-only, first/third-party,
   unknown-origin and mixed-source records against that exact predicate,
   including expiry/removal of the sole source proving organization creation.
   Handle native and chunked description fields; make snippet limits explicit
   and provide complete safe description paging. No raw configuration,
   knowledge sources, connector data or unrestricted inventory detail endpoint.
   Sanitize identity-bearing source text before snippets/chunking/continuation;
   cover titles, contacts, URLs and provenance, not only structured person DTOs.
   Use known saved identity evidence and bounded rendering, with an explicit
   field-withheld state if safe rendering is impossible. Preserve the agent.
   Apply README C's permitted-evidence search rule as well as output redaction:
   hidden identities cannot silently select/rank an agent or become an excerpt.
   Preserve catalog membership and internal champion/popularity computation;
   identity-only probes are not supported task matches.
5. Reuse safe normalized search helpers for the goal and expanded terms.
   Rank task evidence first; use stable canonical identity tie-breaks and
   deduplicate linked provider records without hiding ambiguous evidence.
   Return evidence excerpts/provenance, not numeric relevance/usage scores.
   Establish "candidate", "no matching saved evidence" and "coverage incomplete"
   semantics; do not invent task capabilities or infer no agent exists.
6. Resolve contacts/department through proven saved creator/owner identities.
   Return names/contact only when `hide_employee_details` is false; otherwise
   keep permitted department metadata without personal identifiers or links.
   Keep creation, ownership, modification and usage distinct. Use links only
   when the source provides a verified supported link; actual provider access
   may be unknown or unavailable. Do not auto-share, install, invoke or create
   a sharing-request workflow.
7. Reuse/extract the existing champion ranking once, shared by staff adoption
   and restricted employee reads. Return at most that same three-person set
   with report dates and names/contact only when `hide_champion_employee` is
   false, without scores or activity. When true, expose the privacy-withheld
   state rather than no champions, a named roster or a contact/ID proxy.
   Champion status evaluates the actual self-service caller or explicit preview
   subject and is suggested/not-suggested/unavailable; ambiguous, anonymized
   or absent subject linkage cannot become not-suggested.
8. Resolve workplace scope from the self-service caller's stored user account,
   or the explicitly selected staff-preview account. Department queries filter
   company + department; company queries filter company alone, across its
   departments. Reject other-user input on self-service endpoints, arbitrary
   workplace overrides, unknown/ambiguous/guest/disabled preview subjects and
   forged or cross-subject selections/cursors. Do not derive company from an
   email domain or replace saved fields with live provider values.
   Missing stored fields affect only their dependent scope, never fall back to
   the staff actor, another company or all unknown users. Organization search
   and matching owners in other workplaces stay available.
9. Department use cases distinguish proven created-here and used-here
   relationships. Popularity aggregates distinct users in the requested
   department/company scope from the exact pinned user-agent lineage, with
   canonical deduplication and stable ties. The combined question returns up to
   three eligible agents separately for each scope using one subject, saved
   profile revision and period. Company must not mean the whole tenant.
   Keep all aggregate counts and activity rosters inside the API; fewer than
   three matches or missing evidence must not be filled from another scope.
10. Reuse current live-authority SQL and selection fences for list/detail,
    removed agents, source expiry, actor role/authority changes, subject
    member/active-state or saved workplace changes, concurrent publication
    and report deletion. Do not fetch the subject's app roles for preview;
    they are irrelevant to this restricted lens. Bind self/preview
    contexts to actor, subject, mode, profile scope and data revisions; no sticky
    impersonation or target-role inheritance. Never serve an old unrestricted
    staff payload under a preview/employee selection or an inaccessible
    administrative detail URL. Preview never uses a target token or claims
    to prove their live provider access.
    Apply current privacy on every response or privacy-bound sanitized cache;
    old selections/cursors must not restore identities after a setting tightens.
11. Meet README request/response/cursor bounds. Measure described-search and
    departmental/company aggregation and combined preview using existing scale
    tooling. Finish the current schema/access-path decision above from actual
    results, not speculative scale. Wire the existing explicit reset lifecycle
    to fresh initialization and exact fingerprint/grant verification; do not
    bypass schema guards or add an upgrade/migration path.
    Test interrupted reset/initialization and restart without repeating a
    completed reset. Keep only the minimum security authority needed so reset
    cannot resurrect revoked bearer credentials; business data/history need not
    be carried forward. Use the protected operator/auth owners, not an employee
    data copy or an authentication bypass.
    Give phase 04 an exact reset/resume/source-rebuild contract. Inventory and
    directory rebuild automatically; deleted official reports/history do not.
    Genuine report imports use the existing staff workflow, never inferred
    relationships or synthetic production fixtures.
12. Update directly controlling data/role documentation. Do not build a browser
    catalog, change staff report semantics or implement an MCP-side business
    query. Phase 03 owns the public MCP bindings.

## Focused verification

Create focused discovery service/route/DTO tests in the existing test layout:

```sh
npm run test --workspace backend -- src/services/agentDiscovery.unit.test.ts src/routes/agentDiscovery.unit.test.ts src/services/adoptionGroups.unit.test.ts src/db/inventoryAuthority.unit.test.ts
npm run typecheck --workspace backend
npm run typecheck --workspace frontend
git diff --check
```

Add database-backed discovery cases to the existing large-tenant/MCP fixture
runner, reusing its isolated current-source, reports and authority setup. Record
the exact supported selector/command after integrating it; do not claim the
unit run proves SQL, current-schema initialization or large-tenant behavior.

Exercise fresh initialization and a deliberately populated disposable database
reset into the final schema using the checked-in operator/lifecycle. Verify
fingerprint and least-privilege grants, all affected staff reads/writers,
automatic first-sign-in collection, discarded sessions/selections, retained
protected OAuth state and no resurrection of previously revoked API authority.
Test failure before reset, after database recreation and during initialization;
resume the exact operation without a second destructive reset. No production
reset is performed in this phase.

Verify all twelve README retrieval fixtures, safe complete descriptions beyond
the first page, exact current champion-set equality, no metrics in any nested
response, and eight-term/twenty-card/byte/cursor boundaries. Prove exact top-three
department/company results and preview/self-service equality for the same saved
account and data revisions, with only labels/actor attribution differing.

Required data cases: two companies with identically named departments; another
department's matching private/draft agent; unlicensed/unknown-report caller;
anonymized reports; missing company/department; empty/missing descriptions;
duplicate provider identities/relationship rows; ambiguous report links; ties;
missing/deleted/overlapping reports; source expiry during continuation; tenant,
principal and role changes; and hostile description text or URLs.
Add multiple departments in one company; stored affiliation different from
provider claims/email domain; company missing versus department missing; fewer
than three agents; unknown/ambiguous/guest/disabled preview subjects; target
with Admin assigned; forged EndUser subject; cross-subject continuations;
concurrent previews; and default self-service after preview still using the
real actor's account. Never require the target's sign-in or role assignment.
Run the README four-combination privacy matrix, including a person who is both
creator/owner and champion. Check nested/raw JSON, all description pages,
identity-bearing titles/URLs, chunk boundaries, errors/provenance, hints and
forged include-identity requests. Verify no hidden relationship is reconstructed
through another discovery route or match explanation. Normal staff reads remain
unchanged. Privacy must not recompute popularity/championship or drop agents;
unfiltered catalog membership, own champion status and permitted department
metadata remain usable. Separately test hidden-identity-only search probes;
withheld text cannot provide an invisible match, score or excerpt.
Assert catalog/department reads perform zero provider collection/control calls
after phase 01 authentication/bootstrap. Verify staff adoption ranking and
existing saved reads are unchanged.

Attempt the README capacity measurement with the existing isolated scale data,
at least fifty measured requests per query shape and explicit p95 threshold.
Record query plans, source
counts and actual timing separately from auth/model latency. An unavailable
benchmark remains a scoped residual, not an empty dataset or assumed pass.

## Production continuation

Obey the README always-deploy contract. Phase 04 deploys this API with the
phase 03 adapter. Data uncertainty yields the specific partial/unavailable
answer; unsafe identity or revoked selection fails closed. Safe organization
discovery and unaffected staff paths are not gated by missing department data.
Record residual ownership, numeric signals and fix-forward triggers.

## Completion record and done conditions

Write `completions/02-safe-agent-discovery-api.md` with the README completion
content, exact canonical operation/DTO/selection/preview map, allowlisted/excluded
fields, stored workplace filters, ranking provenance, champion and preview/self
equality, database/query-plan results,
privacy-matrix/raw-output/cache results, schema impact, retrieval/capacity
results, final query-to-storage/index/owner map, reset/authentication-fence/
resume/source-rebuild contract and next-phase inputs.

Done when the canonical API produces every requested employee answer from
permitted evidence, including private/draft organization discovery, with
complete bounded paging, no metric/admin leakage, correct personal scope and
truthful unavailable/no-match states. Staff preview uses those same reads
without changing identity or authority, and both audiences can obtain the
department/company top three. One current schema and its explicit reset/resume
path support those reads and existing staff operations without a data migration
or legacy schema. Phase 03 can bind these exact operations
without joining data, inventing scores or copying staff DTOs.
