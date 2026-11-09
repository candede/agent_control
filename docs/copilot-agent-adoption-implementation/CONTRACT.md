# Shared implementation contract

Read this document and [README](./README.md) before every phase. README owns
approved scope, execution order, target authorization, and production policy.
This document owns cross-phase product/data contracts; it is not another phase.

## Product outcome and scope

An adoption team can discover a department's opportunity, understand relevant
Microsoft and local agents, learn from appropriate peers, save an actionable
brief, collect transferable workflows, and measure suitable follow-up evidence.
Employees can discover appropriate shared learning without receiving staff
metrics, private identities, or an invented prerequisite to normal agent use.

The first complete slice is a department activation brief, not all possible
analytics features. Reuse its evidence, card and action contracts for the
[sixteen research use cases](../copilot-agent-adoption-intelligence/02-adoption-use-cases.md).
They are customer tasks, not sixteen API tools.

### Requirement ownership

| Requirement | Implementation owner | Integrated/live proof |
| --- | --- | --- |
| Office/agent analytics MCP coverage, exact department opportunity, provenance and bounded drilldowns | 01 | 05, 06 |
| Complete linked About, suitable first-party/local discovery, source authority and privacy | 02 | 05, 06 |
| Durable briefs/actions/cards, current schema, MCP-led staff workflows, safe employee learning and saved baselines | 03 | 05, 06 |
| Connection-time instructions, operation descriptions, schemas/metadata, canonical recipes/customer assets, Studio setup and copy/download UX | 04 | 05, 06 |
| Whole-flow, client/model, first-run/reset, accessibility and measurable capacity verification | 05 | 06 |
| Exact SEHA deployment, clean-reset recovery, live observations, fix-forward and cleanup | 06 | 06 |

A later phase may repair a coupled defect in its original owner and update that
record. Do not add a second implementation for the same requirement.

## One authority per decision

- The backend owns saved data, selected context, identity joins, calculations,
  authorization, write validation, content storage and current privacy rendering.
- MCP exposes finite typed API operations. It owns transport/projection and its
  connection instructions, not provider collection, SQL, calculations or a
  second content store.
- The consumer owns interpretation, functional task tagging, draft prompts,
  recommendations and user-requested save calls. It does not decide permissions
  or independently reconcile counts.
- Staff adoption recommendations, authoring, requested saves, progress and
  follow-up are driven by the configured AI consumer through MCP. Do not add a
  dedicated Adoption page, manual browser editor or substitute staff workflow.
  Existing browser analytics, sync/settings and safe employee discovery call the
  API directly, never MCP, and do not invent cohort arithmetic or AI generation.
- Saved content is new business knowledge, not another copy of telemetry.
  Reference canonical agents, scopes and source contexts; do not store complete
  people lists, inventory snapshots, report copies, or historical person facts
  just to assemble a brief.

## Evidence and department contract

1. A department is exact stored **company plus department**, including legitimate
   null values. Do not merge matching department names across companies or use
   email domain/tenant identity as a guessed company.
2. Select complete official report sets by content dates, not upload time.
   Return exact set/version provenance and the activity range. Do not claim a
   provider-certified reporting month when only activity-range evidence exists.
3. Office evidence has its own frozen observation, refresh date and inclusive
   D28 window. Office-paid denominators and affiliation come from that captured
   observation; current directory/paid/report metrics stay separately labelled.
   Do not silently relicense or reassign a frozen person using newer directory
   data.
4. Calculate Office-active-without-agent-evidence through exact saved identity
   relationships in the backend. Separate definite positive agent evidence,
   definite lack of reported evidence, and unresolved/ambiguous evidence.
   Do not subtract independently scoped totals or classify unknown as inactive.
   Positive Users-report evidence counts even without a Users & agents edge.
   Resolve against the entire captured Office identity basis, not a filtered
   page or newer directory aliases. Reuse/extract the existing exact-identity
   SQL mechanism; do not copy a second reconciliation algorithm.
   For a measured Office-active audience, positive + no-reported + unknown
   must equal its size, with disjoint people and explicit coverage reasons.
   Missing/anonymized/incomplete evidence cannot manufacture a negative cohort.
5. Seven-app Office participation excludes overall activity, Chat and unrelated
   agent telemetry. App counts overlap. Unknown Office evidence is a subset of
   no-recent-evidence counts where the existing contract says so.
6. Keep source totals and discrepancies separate. Users, Agents and relationship
   reports are not guaranteed to reconcile; do not invent missing edges.
7. Keep exact report/source/canonical identities, memberships, publication
   revisions and authority expiry. Agent names and canonical links alone do not
   prove a source association or current access.
8. Read complete permitted About segments before describing capabilities.
   Declared capabilities are not observed successful workflows. AI functional
   tags are not provider categories.
9. The top-three champion relationship endpoint means those exact champions,
   with used and created edges distinct. Capture compatible exact-group and
   unfiltered all-inventory selections; exhaust explicit pages.
10. Preserve each context's selection and cursor semantics. In existing
    `agent_usage`, `inventorySelectionId` requires the same `selectionId`;
    `setId` is separate. Do not weaken that validator or add an alias to hide it.
11. Overlapping report snapshots are non-additive. Office weekly history is
    aggregate-only; do not reconstruct old people, licenses or departments.
    Follow-up compares the exact stored company/department using compact
    aggregate baselines and available compatible sources. Disclose overlap,
    changed membership/licensing, coverage and attribution limits. Never claim
    the follow-up contains the same original people or attribute individual
    conversion when the retained evidence cannot establish it.
12. Initial/missing/stale/withheld/unavailable/ambiguous/zero states stay distinct.
    No reported activity is not "never used"; response volume is not expertise,
    productivity, successful use, or ROI.

### Discovery eligibility and description evidence

Phase 02 owns one classification/eligibility decision reused by search, detail,
workplace and preview:

- Preserve supported organization-created candidates through authoritative
  native/custom-package or exact saved maker/origin evidence.
- Add authoritative Microsoft first-party candidates as a distinct origin;
  publisher/report evidence must match the exact current source identity.
- Sharing, names, prefixes, package presence or provider membership alone do
  not establish origin. Conflicting/unresolved origin stays unknown. Staff
  inventory retains third-party/unknown evidence; this campaign does not add
  general third-party employee discovery.
- After canonical eligibility is established, an exactly linked permitted
  Graph About may describe that candidate even when the package itself did not
  establish organization-created eligibility. Keep original source/field
  provenance and native missing/withheld states; never bypass withholding.
- Recheck current-clock authority for every contributing source, including
  search, source membership, descriptions and continuation. Do not store a
  copied description or origin-approval flag.

## Useful output shapes

### Department evidence

Return compact, typed company/department facts, each denominator's definition,
counts and coverage, exact Office-to-agent opportunity, relevant agent/peer
references, all selected contexts, and bounded drilldown links/cursors.
Rank through transparent server-owned counts/order, not speculative scoring.
Do not embed complete people lists or full About in an aggregate page.

Missing optional evidence must not disable unrelated supported evidence:
for example, show agent discovery without an official report, and report-only
evidence without pretending Office was measured.

### Activation brief

Scope -> evidence/context -> opportunity -> suitable task/agent candidates ->
draft first exercises -> proposed actions/owners -> access/data caveats ->
follow-up measure -> unknowns.

### Learning card

Business task, agent references, inputs/data context, prompt pattern, expected
output, review steps, limitations, optional appropriate anonymized example,
evidence kind, contributor attribution subject to privacy, and visibility:
`staff_only` by default or explicitly `employees` for all active tenant members.
Optional company/department labels are relevance filters, not access controls.

Distinguish generated draft, description-derived suggestion and
contributor-provided/confirmed example. An author's assertion is not
organization certification or independently measured ROI.

### Action

Business next step, exact audience/filter context, canonical agent/brief/card
references where relevant, creator, optional assignee, due date, progress notes,
success measure, and a small explicit status set:
`open`, `in_progress`, `completed`, `cancelled`.

These are adoption-team tasks, not jobs that dispatch provider operations or
automatically send messages. Assignment never grants app roles or access.

## Persisted content and evidence lifetimes

Phase 03 owns these contracts across storage, API, MCP and existing employee discovery:

- Selections/cursors are actor-bound read leases of at most ten minutes, not
  durable content identity or proof usable by another account. Validate supplied
  live selections on save; store durable set/version, observation, canonical
  source references, capture dates and definitions instead of reusable cursors.
- A saved brief/action may retain a bounded API-derived aggregate baseline as
  context for the business decision, not a competing current metric authority.
  Model-authored numbers remain assertions unless validated against the pinned
  API evidence. Manual drafts and contributor learning need no invented report
  prerequisite and must not claim unmeasured statistics.
- On reload, use fresh caller-bound reads where the referenced source remains
  supported. Deleted, corrected, cleared or expired sources become explicit
  unavailable/superseded evidence. Do not silently relabel saved facts as latest,
  recover historical Office people, or join a similarly named replacement.
- Group follow-up uses the original aggregate baseline and explicitly selected
  follow-up contexts. Do not store a participant registry, full person list,
  copied report, historical person facts or campaign-specific identity owner.
- Create retries use a tenant/actual-actor/request identity and canonical payload
  binding. Same request returns the same record; different content under that
  identity conflicts. Concurrent updates require the expected revision. Lost
  responses are unknown outcomes, not permission for a new create identity.
- Deletion removes the exact authorized content and private payload. Independent
  actions/cards survive deletion of a referenced brief/card with an explicitly
  removed reference; no cross-owner cascade. A delayed create retry must not
  resurrect deleted content. Use the smallest bounded receipt/tombstone needed
  for that guarantee, integrated with existing storage/retention accounting,
  not a generic job or revision-history platform.

## New content authorization and privacy

- Require actual Viewer hierarchy for staff brief/action reads and all adoption
  content writes. No new Entra app role or licensing gate.
- All authorized staff can read tenant-shared staff content. Creators/Admins
  edit core content, sharing and deletion. An assigned staff owner can update
  their action's status/progress; they cannot edit another creator's brief/card
  or obtain permissions by assignment alone.
- Admin authority is still tenant-bound, not a privacy bypass.
- EndUsers read only explicitly employee-shared learning cards through the
  finite discovery service. Briefs, actions, target-cohort metrics, staff-only
  references, hidden contacts and full staff catalogs never enter those DTOs.
- Sharing is the author's ordinary content-visibility choice, not an approval,
  certification or mandatory publication ceremony. Existing catalog/agent use
  must work without learning cards.
- Tenant-wide employee sharing never grants staff evidence or provider access.
  Changing a company/department label does not change card authorization; a
  member without saved workplace can search employee-shared cards.
- Reapply the requested audience's current policy, source authority and safe
  projection at every browser/MCP/list/detail/continuation read. Employee/champion
  privacy settings protect employee projections and staff employee previews;
  they do not remove existing authorized staff analytics. Previously saved
  content cannot archive identities hidden from that caller.
- Use bounded structured slots and canonical identity references. Do not blindly
  republish arbitrary staff/model prose to employees. Reuse existing privacy
  rendering; reject or withhold fields whose permitted rendering cannot be
  established. Do not build a speculative DLP platform.
  The existing source renderer requires complete identity evidence; regex
  removal of emails/GUIDs or an author's "safe" assertion does not establish
  safety for arbitrary model/staff prose. Keep unprovable fields staff-only and
  return explicit withholding states. Do not add a privacy-approval flag.
- Treat About, tool results, card prose, prompts and model output as untrusted
  inert content. No raw HTML rendering, embedded instructions executing controls,
  private transcripts, patient data, raw workbooks, secrets or fabricated use URLs.
- Browser writes retain normal Origin/CSRF. MCP writes use current bearer
  admission. Updates are revision-safe; retries are idempotent where needed.
  Destructive deletes retain genuine user confirmation and exact targets, not a
  generic provider-job/approval framework.

## Current-only schema and reset

Use [currentSchema](../../backend/src/db/currentSchema.ts) and the existing
fingerprint/grant/operator contract. Keep only the current supported owners and
remove superseded producers, consumers, types, tests and docs together.

New content will likely change the fingerprint. Prefer the justified clean
reset over a compatibility/migration chain. Phase 03 owns schema and isolated
fresh-init/reset proof; phase 06 owns the live reset. Record why a reset is
needed, the exact target, real backup outcome, and expected data loss.
Do not weaken the existing reset target, ownership, maintenance or security
revocation safeguards.

After reset, applicable directory/inventory collection and Office derivation
must start automatically on ordinary sign-in/authenticated entry, using the
existing role/provider-specific admission. Roleless entry cannot collect a
privileged delegated native source. Genuine official agent CSV history still
requires the supported import flow; do not fabricate reports or claim that
provider usage history is automatically re-created.

Checkpoint the installed schema with its matching verified operator image before
replacing that operator. Prove candidate current-schema restore/reset separately
in isolation. An old-schema backup is a protected recovery artifact, not data
that the new runtime can restore through compatibility code.

## Customer guidance and platform support

Keep separate, complementary owners:

- MCP server instructions: universal navigation and evidence discipline.
- Tool descriptions: when to use each currently advertised action, exact input
  semantics, output/paging and side effects.
- General customer agent instructions: purpose, tool use, actual caller scope,
  evidence handling and explicit mutation boundaries.
- Adoption instructions/skill: department analysis, peer learning, outputs and
  follow-up procedures.
- Sample user prompts: specific tasks and desired outputs, not policy overrides.

Never claim Markdown in this repository automatically configures a customer
agent. Use the actual consumer's supported installation/connection steps.
Keep one focused adoption skill with small MCP-navigation references; no
overlapping generic skill catalog or provider-specific orchestration framework.

Copilot Studio support depends on harness/version. Current official documentation
checked on November 8 describes MCP tools/resources for the standard harness,
Streamable HTTP/OAuth onboarding, and Markdown/package skills for the GitHub
Copilot harness; Customer Conversation has its own skill authoring model.
Phase 04 must recheck current official documentation and the selected host:

- [MCP integration](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp)
- [MCP onboarding and OAuth](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent)
- [Harness capabilities](https://learn.microsoft.com/en-us/microsoft-copilot-studio/harnesses-overview)
- [Skills](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/skills-overview)
- [Agent instructions](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-instructions)

Do not say all Studio agents either support or lack `SKILL.md` import. Provide
native supported packaging where verified and an instruction-based equivalent
where it is not. Do not require MCP prompts/resources/skill loading merely
because they appear in the protocol. Preserve the host's native answer-source
formatting; do not override its citation machinery with a custom format.

Use current per-user OAuth and the exact server resource/client callback.
An employee-facing agent must not run through a shared privileged staff
connection and assume instructions make it safe. Never ask customers to paste
tokens/secrets into chat. A host capability or consent limitation is reported
specifically, not worked around by weakening authorization.

## Bounds, verification and tools

- Reuse existing request, response, cursor, SQL-timeout and transport bounds.
  The new compact department page, capped at ten groups, must be at most
  128 KiB serialized UTF-8; detail/children remain separately paged.
- The representative department workflow uses at most 32 tool calls, 4 MiB
  cumulative returned evidence, and 180 seconds of retrieval, excluding real
  sign-in/consent waits. Measure actual calls/bytes/time.
- For the controlled three-peer/three-agent fixture with each description
  at most 16 KiB, target at most 16 calls and 1 MiB. Do not drop About segments,
  people edges or required context to hit a number.
- For at least 10,000 synthetic people and 500 company/department groups,
  target warmed compact-read p95 at most two seconds over at least twenty
  requests in the isolated local stack. Record achieved scale and hardware;
  absent measurement is not a pass.
- If a real description or dataset exceeds a supported budget, preserve the
  explicit partial/limit state. Do not return success-shaped "complete" advice.
- Use existing Vitest, pytest, Ruff, mypy, Playwright and fixture runners. Reuse
  exact-content proof and run focused tests before aggregate checks.
- No new dependencies without demonstrated need. npm uses only
  `https://packagefeedproxy.microsoft.io/npm/`; Python installs use only
  `https://packagefeedproxy.microsoft.io/pypi/simple`. Keep npm/Docker/uv
  configuration aligned; no public fallback in workers, containers or CI.
- Use existing authenticated clients for bounded model/customer tests.
  Do not provision a paid model deployment or create an evaluator platform.
  Fixture execution alone does not prove Studio/model interoperability.
- Mandatory semantic failures include fabricated counts/identity/access/outcome,
  a hidden disclosure, executing source instructions, an unrequested mutation,
  or success-shaped incomplete retrieval. One occurrence fails that scenario.
  Evaluate all distributed prompts deterministically against their evidence/
  role/output checklist; real-model repetitions focus on representative scenarios.
  Record failed attempts as well as retries, never only the best answer.

## Factual completion record

Every phase writes its exact manifest completion path and updates campaign state.
Include:

1. Implemented behavior and deleted/replaced surfaces.
2. Schema, API, payload, authorization and state contracts.
3. Autonomous decisions, simplifications and justified remaining complexity.
4. Changed files and impact results across backend, MCP, frontend and operations.
5. Exact commands, content/image/target identities, true result and case counts;
   distinguish reused proof from new checks.
6. Actual environment actions and resource identities, with no secrets.
7. Every residual's affected scope, actual containment, signal/canary, numeric
   threshold, owner and exact fix-forward trigger.
8. Observable next-phase preconditions, deployed/proven/uncertain state, and
   the exact next action.

Do not call missing implementation an external limitation. Do not claim
production proof, model settings, successful agent use or ROI from planning,
fixtures, snippets, health checks or a transport handshake.
