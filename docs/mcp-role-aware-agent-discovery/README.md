# Role-aware MCP and employee agent discovery

## Goal and planning status

Make Agent Control useful to three audiences without confusing their agendas:
administrators manage agents, adoption teams investigate adoption, and employees
discover agents and colleagues who can help with their work. Authorized staff
can also preview that restricted employee experience for a selected account.

This folder is an approved product plan, not an implementation or deployment
receipt. No application code, Entra setting, database or deployment was changed
while preparing it. Start a future implementation campaign explicitly before
executing the ordered prompts.

## Decisions settled with the user on 2026-11-05

- Create this folder at `docs/mcp-role-aware-agent-discovery`.
- **Do not create an EndUser app role.** A successfully authenticated employee
  with no assigned app roles receives the effective `end_user` audience.
  Anonymous requests, malformed/unknown role claims, failed role validation and
  invited guests do not receive this default.
- Keep `AgentControl.Viewer` for adoption teams and keep
  `AgentControl.UsageReportUploader` and `AgentControl.Admin` unchanged.
  Explicit app-role permissions remain authoritative; Admin includes the
  supported adoption and discovery capabilities.
- Default discovery is for tenant employees/members, not roleless B2B guests.
  Existing explicit role assignments are not revoked by this default policy.
- Employees may discover **all organization-created agents present in saved
  inventory, including private agents and drafts**, through the limited
  metadata contract below. Discovery never grants permission to use an agent.
- Personal scope comes from the stored user account: department queries filter
  by **company + department**, and company queries filter by **company** across
  its departments. Goal-based discovery searches the organization.
- Actual employees can ask for the top three popular agents in both their own
  department and company, without activity counts or adoption metrics.
- Viewer, Uploader and Admin can make a read-only EndUser preview for an active
  member account in the same tenant, for example "Assume I am abc@domain.com."
  The selected account supplies the stored company/department; the authenticated
  staff user remains the actor and authorization principal. No impersonation,
  target token, role borrowing, account switch or administrative action as the
  target is permitted. Preview uses the same restricted discovery services.
- Show relevant champion and creator/owner names and corporate contact only
  when the corresponding deployment privacy setting allows it. The independent
  `hide_employee_details` and `hide_champion_employee` switches both default to
  `false`. Apply them to actual EndUser discovery and staff EndUser previews,
  not ordinary adoption/admin operations. Department names, agent explanations,
  rankings and own champion status remain available without usage metrics.
- Reuse the existing report-based champion suggestion, clearly labeled and
  dated. It is not an appointed title, certification or productivity assessment.
- Build the MCP/AI-agent experience only. Do not build an employee browser
  catalog or expose adoption/admin browser pages to roleless users.
- Use the conversational AI to interpret goals and expand search terms.
  The API searches and ranks saved catalog evidence. Do not add a server-side
  model service, embeddings or a vector database.
- Support each user's own OAuth identity in supported MCP clients and validate
  a published Copilot Studio experience. Never use the author's/admin's shared
  connection as the identity for employee questions.
- The future rollout targets the **existing `seha` production installation on
  its current host using its existing deployment lifecycle**. Preserve data,
  volumes, app registrations, OAuth keys and connections.

## Current evidence and target flow

Source inspection established the following; it did not run application tests:

- [Role types](../../backend/src/types/capability.ts) define Viewer, Uploader and
  Admin, with no EndUser role.
- [Route policy](../../backend/src/routes/policy.ts) and
  [agent controls](../../backend/src/routes/sharedAgentControls.ts) enforce
  Admin for controls. Execution protection already exists.
- [Tool registration](../../mcp/src/agent_control_mcp/tools.py) registers every
  [public family](../../mcp/src/agent_control_mcp/domains.py) without
  caller-specific filtering. Tool visibility is not currently role-specific.
- [MCP claims](../../mcp/src/agent_control_mcp/auth.py) and
  [API bearer admission](../../backend/src/auth/mcpBearer.ts) reject roleless
  API tokens. The [registration guide](../../infra/entra-id-api-mcp-app-registrations.md)
  currently requires app-role assignment.
- [User collection](../../backend/src/services/userSourceProvider.ts) primarily
  selects Copilot-licensed or reported users. It cannot establish that every
  employee, especially an unlicensed new caller, is a guest or has a department.
- [Automatic refresh](../../backend/src/services/dataSync.ts) currently requires
  Viewer. This must not leave an employee-first installation permanently empty.
- [Adoption groups](../../backend/src/services/adoptionGroups.ts) already compute
  company/department champions and join saved agent descriptions, but their
  full payload contains people/activity metrics unsuitable for employees.
- [Runtime metadata](../../mcp/src/agent_control_mcp/service.py) supplies a global
  catalog to [MCP settings](../../backend/src/routes/mcpSettings.ts). That page
  also needs the current caller's projection, not a second static tool list.
- The [Studio connection reference](../copilot-studio-mcp-connection.md) proves
  author-test saved-data access, not published per-end-user identity.

**Current flow:** assigned user -> common MCP catalog -> canonical API role and
provider checks -> saved adoption/admin data or an explicit provider operation.

**Target flow:**

1. Normal OAuth sign-in establishes the actual tenant user and current app roles.
   A roleless caller additionally needs authoritative active-member evidence.
2. The API determines the effective audience and allowed canonical operations.
   MCP projects its existing native tools and their action schemas for that user.
3. Normal sign-in automatically schedules due application-owned read collection
   through the existing API collection owner, including on employee-first use.
   This is not an MCP scheduler or a discovery-tool side effect.
4. A discovery question reads the shared saved catalog, approved metadata and,
   where relevant, one pinned report period and stored workplace scope.
   Self-service uses the caller's saved account. An explicitly authorized staff
   preview resolves the selected account instead, without changing the actor.
5. The API applies its deployment-owned privacy policy and returns restricted,
   evidence-bearing results before employee identities can reach MCP or the AI.
   The conversational AI
   explains matches, names relevant colleagues, and distinguishes discovery
   from actual provider access. Missing evidence remains explicit.
6. Every invocation is still authorized by the API, even if a client cached an
   old schema, names a hidden tool or forges a family action.

**Design verdict: reuse and narrow, not build a new catalog platform.** Keep one
API business owner, existing inventory/report authorities, existing collection
jobs and the existing Python MCP catalog owner. A separate EndUser assignment,
catalog database, social graph, custom protocol server, publication/opt-in
workflow, recommendation service or sharing-request queue is unnecessary.
Simple name-only search is insufficient: approved descriptions and AI-expanded
goal terms must participate, with concrete relevance tests.

Necessary complexity is limited to verified employee eligibility, restricted
response DTOs, principal-bound selections, deterministic evidence ranking, and
per-request tool/action/schema projection. Preview adds only a validated
actor/subject distinction and reuses those reads, not a session impersonation
framework or a parallel employee API implementation. These protect real access
and result correctness; they are not new acceptance or feature-enable gates.

## Repository roots and ordered manifest

All application roots are in this repository: `backend`, `mcp`, `frontend`,
`scripts` and `infra`. Resolve them from the executing checkout, not a remembered
machine path. Read [AGENTS.md](../../AGENTS.md) and the installed
`implement-folder` and step-worker contracts before executing a phase.

Execute exactly these four prompts in order. README is shared policy, not a
phase. Completion records and `completions/IMPLEMENTATION_CAMPAIGN.md` are
created during implementation, not fabricated during planning.

| Order | Prompt | Outcome / owner | Prerequisites | Exact completion record |
| --- | --- | --- | --- | --- |
| 01 | [Roleless discovery authority](01-roleless-discovery-authority.md) | Audience/preview authority, deployment privacy configuration, onboarding, automatic first-run collection and browser handoff | None | `completions/01-roleless-discovery-authority.md` |
| 02 | [Safe agent discovery API](02-safe-agent-discovery-api.md) | Privacy-enforced catalog, stored workplace scope, champion/popularity reads and shared staff preview | 01 | `completions/02-safe-agent-discovery-api.md` |
| 03 | [Role-aware MCP surface](03-role-aware-mcp-surface.md) | Native discovery/preview tools, projected schemas/guidance, invocation protection and matching settings/privacy metadata | 01 and 02 | `completions/03-role-aware-mcp-surface.md` |
| 04 | [Verify, deploy and observe](04-verify-deploy-and-observe.md) | Aggregate/client/first-run proof, bounded `seha` deployment and live fix-forward convergence | 01, 02 and 03 | `completions/04-verify-deploy-and-observe.md` |

Each phase implements and verifies its own contract. Phase 04 is not the owner
of unfinished earlier functionality.

## Binding product and implementation contracts

### A. Audience, identity and authorization

| Audience | Authority | MCP surface |
| --- | --- | --- |
| `end_user` | Valid configured-tenant delegated user, no app roles, verified active employee/member | Discovery only |
| `adoption` | Viewer or Uploader, including existing role inheritance | Authorized existing adoption/saved-read/collection operations, discovery and read-only employee preview; no Admin-only operations |
| `admin` | Admin | All currently supported authorized operations, discovery and read-only employee preview; real provider checks and confirmations remain |

These are effective audiences, not additional Entra app roles. Preserve the
three existing role values and role hierarchy. Empty/absent valid role claims
are different from malformed claims, unknown roles and failed revalidation.
Unknown/malformed claims are rejected; no error path promotes or defaults them.

The canonical route/operation policy is authoritative. Supply MCP a bounded,
authenticated access projection from that policy; do not copy a second
authorization matrix into Python or infer authority from tool descriptions,
read-only hints or Microsoft directory roles. Do not filter tools based on
provider readiness: a permitted operation can still report a real provider
limitation when called.
Where an operation has finer role-controlled choices, such as capability probe
IDs, include those finite constraints from its existing API guard/registry.
A Viewer-allowed route does not make every administrative enum value available.

Employee eligibility uses the verified tenant-local `oid`, not a display name,
an arbitrary username, a caller's department or the composite home-account ID.
Use bounded exact application-directory lookup for active-member eligibility
evidence where the current saved directory cannot cover the caller. Reuse
existing Graph application credentials and `User.Read.All`; do not require
Copilot licensing, a directory-reader role or inventory synchronization.
Keep this in the authentication/profile boundary, not catalog business reads.
Reuse current directory parsing and bounded auth/cancellation helpers; any
short-lived profile cache is non-authoritative and bound to tenant, actual user,
expiry and current account authority. Do not create a shadow employee directory.
Unavailable membership verification is an explicit provider/authentication
error, not guest-to-member inference or a request for manual synchronization.

Use the canonical stored user account's company/department for personal
questions, for both self-service and preview. Membership verification must not
silently replace these fields with token claims, live provider fields, email
domains or caller-supplied values. Normal existing source owners maintain the
stored profile. Missing stored company/department disables only the affected
scope; it never means the whole tenant or all people with missing fields.
Missing report data disables only the corresponding report-based answer.
Organization catalog search remains usable for an authenticated eligible user.
Assigned users keep their existing explicitly authorized capabilities.

Staff preview requires the current real actor's Viewer hierarchy, including
Uploader/Admin. Resolve the supplied UPN/corporate account identifier exactly
and uniquely to a stored active same-tenant member; unknown, ambiguous, guest
or disabled targets are explicit failures. Do not require the target to sign
in, consent to a new workflow or receive an EndUser role. Keep actor roles,
tokens, tenant, attribution and account authority unchanged; the target's roles
never grant the actor anything. This is an EndUser lens even if the target has
an assigned staff role.

Preview is explicit and request-scoped, not a persistent "act as" switch.
Return clear preview/subject context labels using the same safe DTOs, subject
to the privacy rules in contract C; no hidden owner/champion identity is echoed
as a shortcut for labeling the preview.
Bind preview selections/cursors/caches to the real actor, subject, self/preview
mode, saved profile scope and data revisions. Prevent cross-subject replay and
invalidate affected scope when the stored account fields change. A later normal
self-service call still uses the actor's own account. Attribute requests to the
real actor through existing restricted telemetry/audit; no raw target emails in
general logs or new impersonation/audit subsystem.
Actual EndUser callers cannot select another account, call the staff preview
entry point or reuse its contexts. Preview is read-only and does not prove the
target's OAuth connection, live provider permissions or ability to use an agent.

### B. Automatic first-run behavior

Keep the existing Viewer/Admin browser automatic synchronization working after
normal deployment, isolated reset and sign-in. Also make employee-first browser
or MCP sign-in schedule due configured **application-owned read sources**
without needing a privileged user to visit a page or press Sync first.

Own this in the existing API authentication/automatic collection lifecycle.
Separate internal application-only automatic admission from interactive Viewer
sync authorization. Retain actual caller attribution, tenant application
credentials, existing leases/concurrency/retry controls and source permissions.
Never forge a Viewer/Admin role, borrow an administrator's connection, grant
employees manual sync/job APIs, or expose an EndUser sync tool.
Do not add a second scheduler, collection writer, startup approval or readiness
check prerequisite. Catalogue/tool reads themselves remain provider-free after
authentication; record automatic sign-in collection separately in tests.

Power Platform's delegated-only inventory cannot be bootstrapped with imaginary
application permissions. Preserve collection when a genuinely authorized reader
signs in; otherwise report its coverage gap. Imported usage reports likewise
cannot be invented. First-run catalog answers must state initializing/missing
sources honestly while automatic authorized reads proceed.

### C. Approved employee data

Use new positive allowlist DTOs and queries, not full adoption/inventory DTOs
followed by cosmetic AI instructions or serialization-time field deletion.

Allowed agent metadata, subject to the privacy policy below: canonical identity,
display name, source-provided
business-purpose descriptions, relevant creator/owner display names and
corporate contact, proven department affiliation, draft/published/unknown
lifecycle, and a verified provider-supplied use link when one exists.
Include limited source identity, observation/coverage status and description
provenance needed to explain evidence. Contact identity is not proof an address
is deliverable; do not invent email addresses or infer ownership from modifiers.
Do not fabricate use URLs, promise access from "available to some users", or
route employees to protected administrative detail pages as use links.

Explicitly exclude usage counts, response totals, adoption rates/scores, license
details, other users' activity, raw reports, controls/jobs, audit/security
evidence, access-assignment principals, credentials, internal prompts,
instructions, connectors and knowledge-document content. Ordinary report dates,
catalog paging limits and ordered result positions are not adoption metrics.
Do not expose hidden metrics through scores, explanations, facets, debug fields,
schemas or total-count aliases.

Include private/draft organization-created records without a new publication
workflow. Respect actual saved source authority and removal/revocation fences.
Uncollected agents cannot be discovered; partial coverage is not proof there
are no other agents. Do not broaden this feature into third-party marketplace
enumeration or execution of discovered agents.

#### Deployment-owned employee privacy

These are intentional privacy settings, not feature-enable/release gates.
Persist the exact keys `hide_employee_details` and `hide_champion_employee`
in the existing deployment MCP settings. Both are global booleans for this
deployment, defaulting to `false` when absent; explicit saved values survive
edit/redeploy/restart. Reject malformed values rather than coercing strings or
silently falling back. No per-user, company, tool-request or client override.

| hide_employee_details | hide_champion_employee | Creator/owner identity in EndUser results | Champion identity in EndUser results |
| --- | --- | --- | --- |
| false | false | Names and corporate contact allowed | Names and corporate contact allowed |
| true | false | Hidden; department may remain | Names and corporate contact allowed |
| false | true | Names and corporate contact allowed | Hidden; department may remain |
| true | true | Hidden; department may remain | Hidden; department may remain |

`hide_employee_details` controls creator/owner identification; it is not a
master switch for champions. `hide_champion_employee` independently controls
identification as a champion. If a person has both roles, an allowed category
may name them, but must not link that identity to the hidden category.
Do not promise irreversible anonymity against facts the caller already knows.

Keep the API as the single effective policy owner. Deployment supplies its
typed runtime values; MCP receives effective flags through the authenticated
access profile instead of independently deciding them from client input or a
second environment-policy implementation. Extend existing local/Compose and
supported Azure configuration producers consistently without changing secrets.
The read-only browser MCP settings page shows the current API-owned effective
values, clearly separate from MCP-observed metadata/reachability. No editable
browser toggle, new configuration database, redaction service or approval flow.

Enforce before API JSON/MCP structured content, text content, snippets, full
description continuations and preview results leave the safe discovery boundary.
Hiding a category removes its employee names, emails/UPNs, personal object IDs,
profile/contact links and identity-bearing provenance/error details, not merely
the name fields. Sanitize identity-bearing agent titles/descriptions/use links
using authoritative saved identity evidence and bounded existing rendering
helpers. Redact before excerpting/chunking so split names/addresses do not
reappear across continuations. Never fabricate a replacement use URL.
If a field cannot be safely rendered, explicitly mark that field withheld and
keep the agent and remaining nonidentifying task evidence, rather than emit
unsafe source text, drop the agent or claim the entire record is unavailable.
Do not add a generic NLP/model privacy service or scan the whole directory on
every catalog read.

Names withheld is not no owner/no champions/no data. Return an explicit
privacy-withheld state while retaining department/company scope, report dates,
agent identity, nonidentifying descriptions/use cases and the same internal
ranked set. Champion suggestions can be reported as available with identity
hidden, without person IDs, stable employee pseudonyms, contact hints or usage
counts. Own suggested/not-suggested/unavailable champion status remains usable
without naming the subject. Do not recover hidden relationships through search
filters, match explanations, citations or another discovery/detail/About route.

Staff preview always uses the same privacy policy as genuine EndUser reads,
even for an Admin actor. Policy follows the EndUser data contract, not just
whether the actor has app roles: staff using the ordinary employee discovery
tools also receive that restricted output. Existing ordinary adoption/admin
tools retain their authorized unredacted behavior; do not mix those results
into an EndUser-preview answer to bypass its policy. This does not revoke staff
permissions or erase information already present in a privileged conversation.

Bind any sanitized-result/projection cache to the effective privacy revision,
or reapply current policy at every response. Tightening policy must protect new
responses even with old selections, OAuth sessions or cached tool schemas;
never require key rotation, OAuth cache deletion or a feature requalification.
Already returned data/client conversation history cannot be retracted. Verify
privacy with fresh conversation evidence, not a claim that the model forgot it.

### D. Workplace, champion and relevance semantics

- Scope department evidence by the selected stored account's company/department
  tuple, and company evidence by its company field alone. Self-service always
  selects the real caller; only the staff-preview entry point may select another
  account. Neither accepts arbitrary workplace overrides. Organization search
  may return matching agents from any department/company.
- Champion suggestions reuse current top-three logic: reported responses
  descending, distinct used-agent count descending, then the current stable
  name/identity tie-breaks, requiring activity. Reuse/extract its owner; do not
  implement a conflicting ranking in MCP.
- "Am I a champion?" compares the self-service caller or explicit preview subject
  with that same suggested set.
  Return suggested/not-suggested/unavailable with the report window and reason;
  absent/anonymized/ambiguous evidence is not a negative result.
- Department use cases come from approved descriptions of agents proven used
  or created there. Distinguish "used here" from "created here"; neither is
  inferred from an owner's name or popularity.
- "Most common" orders agents by distinct users in the requested department or
  company scope in one pinned user-agent report lineage. Company scope includes
  all departments of that stored company, not other companies in the tenant.
  Use deterministic ties and canonical deduplication. A request for top three
  returns up to three eligible ranked agents for each requested scope, using
  the same subject, saved profile and reporting period; fewer matches or missing
  evidence remain explicit, without filling from another scope.
  The aggregate stays server-side; no counts/scores or named usage rosters leave
  the API. Missing relationships mean unavailable, not invented popularity.
- Goal matching ranks textual task evidence before department affiliation or
  popularity. AI-expanded terms such as "business requirements document" can
  support "BRD"; the API returns exact matching description evidence and source
  provenance. A keyword match is a candidate, not proof an agent can execute a
  task. No relevant evidence means a truthful no-match/insufficient-evidence
  answer, not a popular unrelated recommendation.
- Identify others solving a similar problem through relevant agent
  creator/owner metadata and champion contacts, not private conversations,
  inferred personal projects or unrestricted user activity searches.

### E. Data ownership, bounds and MCP wire contracts

Reuse shared canonical inventory, current source memberships, directory facts,
official report lineages, selection/cursor owners and current authority SQL.
In particular, use [inventoryAuthority](../../backend/src/db/inventoryAuthority.ts)
with expiry against the current database clock; a saved membership alone is not
live authority. Never create an employee-owned copy of the tenant inventory.
Exact detail reads and joins must validate tenant, principal, authorization,
current authority, selected subject/mode/workplace scope, selection/revisions
and source identity, including after revocation or concurrent refresh.
Existing unrestricted staff selections are not safe preview or employee
authorization.

Reuse supported selection capture/paging rather than invent a context store.
Bound search to a 512-character goal, at most eight expanded terms of at most
128 characters, default five and maximum twenty result cards per page, and the
existing bounded cursor contract. Reject excess/invalid input explicitly.
Search across approved full descriptions, including chunked About fields;
bounded snippets disclose clipping and link to safe complete description
continuation. Preserve identifiers, stable ordering and source provenance.
Popularity honors the requested top-N within the same twenty-card bound; the
department/company top-three question requests three separately for each scope.
Reuse existing time/byte/concurrency budgets. Any necessary search index is a
derived optimization maintained by the existing inventory owner, not a second
catalog authority. Preserve data, current-schema/fresh-init parity and grants;
no reset or historical migration framework is authorized.

Filter entire unauthorized tools **and disallowed family variants**, including
descriptions, input/output schemas and unreachable `$defs`. Never mutate the
global registry for one user. A family with one surviving branch retains its
family request/result envelopes. Recompute annotation hints from surviving
operations without treating them as permissions.

Use the pinned SDK's supported request-scoped mechanisms and prove real
initialize/list/call behavior. Common role-neutral initialize instructions plus
role-projected tool descriptions are sufficient if initialization is static;
do not introduce a custom protocol engine just for dynamic instructions.
Employee-visible guidance must not encourage adoption metrics or management.
Metadata shown to staff in MCP settings must use the same projection and SDK
serialization as their actual discovery, with existing independent metadata
credentials and no delegated business authority from that credential.
Keep unprojected operational metadata restricted to its existing internal owner.

### F. Required outcome proof and single owners

| Requirement / representative journey | Implementation owner | Focused and integrated proof |
| --- | --- | --- |
| Roleless member, unlicensed employee, guest denial, malformed claims, role changes | 01 | Auth/profile/route tests; real individual OAuth in 04 |
| Independent deployment privacy switches, both default false | 01 | Typed parsing, persistence and local/Compose/Azure producer parity |
| Employee-first automatic app reads, no manual sync privileges; existing first-run preserved | 01 | Isolated fresh-init/first-sign-in and source dispatch assertions; live normal sign-in in 04 |
| "Who is the agent champion in my department?" and "Am I a champion?" | 02 | Same exact top-three set, identity/group isolation, dated unavailable states |
| "What use cases are in my department?" | 02 | Proven used/created edges without metric/roster leakage |
| "Top three agents in my department and company" | 02 | Stored company+department versus company-only filters, same-period distinct-user ranking and no counts |
| "Assume I am abc@domain.com" for Viewer/Uploader/Admin | 02 | Same safe reads as that account's self-service, immutable real actor, explicit preview, no role/token borrowing |
| "Is there an agent to review BRD documents?" or a described goal | 02 | Organization-wide approved description search, evidence ranking, no-match semantics |
| Private/draft discovery, owner contact, use-link honesty and revocation | 02 | Allowlisted DTOs, removed/stale identities, full descriptions and boundary-sized paging |
| Identity hiding without changing agent/champion/popularity computations | 02 | All four privacy combinations, raw JSON/text/continuation leak checks and preview/self parity |
| Adoption tools exclude Admin actions; EndUser has discovery only and no other-user preview | 03 | Actual SDK schemas, forged subject/preview calls, concurrent users, cache/reauth tests |
| Settings reflects the staff catalog and effective privacy flags | 03 | Real API/MCP metadata equality, separate API policy values and read-only browser tests |
| Published Studio uses the actual end-user connection | 04 | Two employee identities from different departments and distinct staff-role connections |
| Existing staff journeys and `seha` production convergence | 04 | Aggregate evidence, exact deployed revision, live observation and fix-forward |

Create eight positive retrieval fixtures covering acronym/expanded BRD intent,
paraphrased goal, another department, private agent, draft agent, conflicting
popularity, multiple relevant candidates, and a match beyond the underlying
inventory's first page.
Each must return the evidence-supported expected candidate in the first five
results after the fixture's specified AI-style term expansion. Add four
negative cases for unrelated popular agents, empty descriptions, no match and
embedded hostile source instructions. Deterministic expected-result and
no-leakage checks must pass for all twelve cases; they are not a model benchmark.

Measure API search/popularity p95 at no more than two seconds over at least fifty
measured requests after warmup on an isolated fixture with 100,000 directory
people, 200,000 catalog records and 1,000,000 user-agent edges. Time auth/model
latency separately. Cover department, company and combined preview reads, not
only a convenient search query. Reuse the existing scale fixture/tooling and
record machine,
dataset, query plans, response sizes and actual results. Unavailable capacity
proof remains unavailable and gets production telemetry, not a fictional pass.
Phase 04 separately exercises natural-language conversations and records the
actual client/model, expanded request, selected tool and grounded answer.

Workplace fixtures must include identical department names in two companies,
multiple departments in one company, a subject whose stored company differs
from their email domain/provider claim, fewer than three eligible agents, missing
stored fields and profiles changed during continuation. For each staff role,
compare the preview of a synthetic member with that member's genuine self-service
results using the same saved data/report revisions. Only preview labeling and
actor attribution may differ. Verify unknown/guest/ambiguous targets, a target
with Admin assigned, EndUser forged-subject calls, concurrent preview subjects,
cross-subject cursors and return to the real actor's default self-service.

Run the four privacy combinations for genuine EndUser and each staff preview.
Include a creator who is also a champion; embedded names/addresses in agent
titles/descriptions/links; identifiers split across source chunks; errors,
provenance and nested DTOs; self champion status; withheld versus absent data;
ordinary staff reads; forged client overrides; and cached responses/continuations
after tightening settings. Assert unchanged eligible agent IDs, report periods
and internal ranking, while hidden category identities never reach the AI.

## Binding always-deploy production contract

This policy applies to every phase after the user starts the future campaign.
It is deployment workflow, never runtime authorization or an application gate.

- Finish with production deployment, observation and fix-forward handling,
  not test-only readiness. Target only the current `seha` installation.
  Resolve its host, Docker context, project, origins, services, volumes, current
  images and receipts from the existing deployment owner before mutation.
  Do not substitute this macOS checkout's default Docker project, another host,
  an Azure VM or a historical installation.
- The future campaign covers bounded local isolated validation and deployment
  of the affected app/API/MCP services to that installation, plus the necessary
  assignment-required configuration for the existing OAuth registrations.
  Preserve explicit role assignments, consent, credentials, callbacks, keys,
  persisted records and connections. No database reset, live destructive test,
  broad tenant permission grant, app registration recreation, commit, push or
  new branch is authorized. Plan creation does not execute these actions.
  Honor the two configured privacy values; do not weaken or cycle production
  privacy through all combinations merely to obtain test evidence.
- Attempt applicable focused, aggregate, database, SDK, model/client, browser,
  restart/restore and capacity checks using existing tooling. Repair reproducible
  defects and record `passed`, `failed`, `not_run`, `unavailable` or
  `inconclusive` truthfully. None alone is a release veto or becomes `passed`.
- For every residual, record affected scope, existing containment, signal/live
  journey, numeric alert threshold, owner and exact fix-forward trigger.
  Authorization and uncertain identity fail closed; unavailable department
  evidence affects that answer, not the safe organization catalog or staff
  flows. Never expose unsafe private data to work around a failed check.
  Use existing authorization, bounded request and explicit unavailable/error
  paths; do not add feature-enable, requalification, release acceptance or
  canary-approval prerequisites to normal use.
- Deploy safe/unaffected paths and necessary hardening while repairing any
  affected unsafe authority. Isolate synthetic qualification in disposable
  environments; live checks use real authorized accounts, read-only production
  journeys and no fixture authentication or customer-data pollution.
- Observe the exact deployed content and critical/unrelated journeys.
  A live defect requires containment -> root fix -> focused verification ->
  exact redeployment -> rerun. Do not resurrect a superseded implementation.
- Clean only exact campaign-owned disposable resources; failures remain owned
  cost/security incidents and do not cancel deployment.
- Actual inability to execute the authorized control-plane actions leaves
  `deployment_pending` with the exact resumable action. Unproven affected live
  journeys remain `production_hardening_pending`, not completed or test-only
  success. No extra approval is required merely because tests were incomplete.

Missing interactive Entra/Studio credentials must be entered in the operator's
approved terminal/client, never in chat, prompts, screenshots or completion
records. Published per-user identity cannot be claimed from author test chat.

## Completion evidence

Each phase writes only its exact completion record from the manifest. Include
implemented/deleted behavior, material decisions, contracts, affected/unchanged
roots and evidence, changed files, actual commands/results/counts/content
identities, authorized environment actions, residual containment/thresholds/
owners/triggers, release state and next-phase preconditions.
Use `completions/IMPLEMENTATION_CAMPAIGN.md` for the manifest, prompt/README
hashes, current phase, target identity, accumulated evidence and exact next
action. Preserve user edits and unrelated work.

Dependencies may be installed only after a manifest change or missing-tool
failure, using the approved npm/Python proxy feeds in [AGENTS.md](../../AGENTS.md),
including subprocesses and containers. Do not download from public indexes.
Use the required GPT-6.1 Sol / xhigh settings if delegating under the installed
implementation contract and record actual launch settings. Prefer direct work
where delegation is unnecessary; do not add mandatory reviewer ceremonies.
