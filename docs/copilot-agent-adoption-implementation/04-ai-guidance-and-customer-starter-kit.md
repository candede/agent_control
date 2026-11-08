# 04 - AI guidance and customer starter kit

## Mission and prerequisites

Deliver one coherent AI-consumer experience: the instructions/tool descriptions
actually received from MCP, executable current recipes, and copy/download
customer assets in the built app. Implement these together, not an internal
document followed by a second independently maintained recipe campaign.

Prerequisites: phases 01-03 and their exact completion records:
`completions/01-evidence-apis-and-mcp-reads.md`,
`completions/02-safe-discovery-and-agent-descriptions.md`, and
`completions/03-adoption-workspace-and-learning-cards.md`.
Read them, campaign state, [README](./README.md), and [CONTRACT](./CONTRACT.md).

No hosted model service, new paid agent/model deployment, new client transport,
permission change or provider-control implementation is in scope. Repair coupled
contract defects at their existing owner; do not make prose an authorization or
metric engine.

## Read first

- [Single server instruction owner](../../mcp/src/agent_control_mcp/instructions.py),
  [service initialization](../../mcp/src/agent_control_mcp/service.py).
- [Canonical operation descriptions](../../mcp/src/agent_control_mcp/tools.py),
  [domain construction](../../mcp/src/agent_control_mcp/domains.py),
  [validators](../../mcp/src/agent_control_mcp/inputs.py),
  [audience projection](../../mcp/src/agent_control_mcp/projection.py).
- [API metadata owner](../../backend/src/services/mcpSettings.ts),
  [metadata type](../../backend/src/types/mcpSettings.ts),
  [settings UI](../../frontend/src/components/McpSettings.tsx),
  [app/employee handoff](../../frontend/src/App.tsx).
- [Metadata equality tests](../../mcp/tests/test_settings_metadata.py),
  [client examples](../../mcp/tests/test_client_examples.py),
  [workflow tests](../../mcp/tests/test_workflows.py),
  [shared corpus](../../backend/scripts/fixtures/mcp-workflows.json),
  [settings UI tests](../../frontend/src/components/McpSettings.test.tsx).
- [Customer connection guide](../mcp-clients.md),
  [Studio connection contract](../copilot-studio-mcp-connection.md),
  [existing client assets](../../mcp/examples/clients/).
- [Research skill design](../copilot-agent-adoption-intelligence/05-ai-agent-skill-design.md),
  [sixteen use cases](../copilot-agent-adoption-intelligence/02-adoption-use-cases.md),
  [prompt library](../copilot-agent-adoption-intelligence/04-prompt-library.md).
- [App image/build packaging](../../Dockerfile), existing frontend asset/import
  patterns, installed agent-customization guidance when authoring skill files,
  and the current official host links in CONTRACT.

Inspect initialize/tools-list/metadata output, not just source strings. Identify
one canonical checked-in customer asset owner that current build/runtime paths
actually deliver; repository Markdown is not automatically in the app image.

## Required delivered guidance

| Surface | Required outcome |
| --- | --- |
| MCP server instructions | Concise universal navigation/evidence rules from the existing single instruction owner |
| Tool/action descriptions | Goal, exact input/context constraints, output/paging, side effects, caller scope and recovery at canonical operation owners |
| General customer instructions | Copy-ready purpose, advertised-tool use, actual connection scope, evidence handling and explicit mutation boundaries |
| Adoption-team instructions | Department activation, peer learning, starter packs, saved actions and qualified group follow-up |
| Employee instructions | Safe task-first profile/catalog/cards/contact guidance; no staff counts or privileged connection |
| Focused adoption skill | Actual `SKILL.md`, small evidence dictionary, canonical recipes and output templates; MCP navigation inside this skill |
| Studio setup/matrix | Harness-specific transport/OAuth/callback/connection/instructions/skill installation and actual verification limits |
| Sample prompts | All sixteen staff use cases plus employee/save/progress/recovery variants and measurable evidence/output checklists |
| Built app delivery | Role-appropriate copy controls and downloadable real assets with resolving packaged references and source/version identity |

Keep complementary layers distinct; do not maintain repeated DTO catalogs,
separate generic/adoption skills or independently edited UI/doc/skill recipes.
Reuse the shared contract-tested corpus for concrete tool-input examples.

## Concrete work

1. Establish a falsifiable baseline: current delivered guidance should let the
   caller select an exact department, retrieve complete permitted evidence and
   explicitly save through existing contracts without hidden tools or authority
   changes. Preserve actual current-client behavior before changing wording.
2. Update the single server instruction owner with role-aware navigation,
   independent report/Office pins, API-owned cohorts, exact champion edges,
   complete source-qualified About, cards and explicit save/progress intent.
   Explain automatic authenticated entry separately from user-requested manual
   sync/provider controls; no capability check or staff bootstrap for saved reads.
3. Improve affected descriptions and schema field explanations at their real
   canonical owners. Preserve generated domain descriptions, role-filtered
   advertising, saved-read/write annotations and current validators. Explain:
   - `agent_usage` requires matching inventory selection fields; `setId` is separate.
   - Exact-group plus unfiltered inventory champion selections and full paging.
   - Independent Office context, frozen denominators and aggregate-only history.
   - Durable content references versus expired actor-bound read selections.
   - Create request/payload binding, expected update revisions, unknown lost
     outcomes, deletion and confirmation without automatic mutation replay.
4. Add shared executable recipes for evidence -> peers -> complete descriptions
   -> explicit save, and roleless task discovery -> tenant-shared safe card.
   Cover stale/missing/withheld evidence, limit states and recovery without
   silently changing periods or inventing zero. Do not weaken typed inputs to
   accommodate a model mistake.
5. Author general, staff-adoption and employee customer instructions plus one
   focused skill against delivered current operations. Universal rules remain
   compact; functional tags, drafts, source declarations, observed usage and
   contributor-confirmed learning stay distinct. No generated prompt claims to
   be an actual employee transcript, expertise, verified access, outcome or ROI.
6. Recheck official documentation and the actual selected Studio harness.
   Record source/date and tested support; native file/package skill import only
   where verified, with supported instruction-only equivalents otherwise.
   Preserve host-native answer-source formatting. Protocol resources/prompts
   do not imply automatic skill loading.
7. Document per-user OAuth, exact MCP resource/client callback and connection
   identity, instructions placement, test chat and publication verification.
   Do not use a shared staff/Admin connection for employee answers, paste secrets
   in chat, delete OAuth caches or rotate signing keys to refresh guidance.
   Existing provider consent/publication requirements are real host conditions,
   not new app-owned approval.
8. Supply the prompt matrix below with novice/experienced variants, actual
   advertised evidence paths, required source state and expected response
   checklist. Missing evidence still yields a useful qualified draft or exact
   limitation; no invented HTTP/SQL proxies, access barriers or hidden tools.
9. Wire MCP settings/setup copy/download UX and appropriate employee handoff to
   canonical assets and current non-secret connection values. Employee delivery
   must not expose the staff metadata endpoint/catalog. Show loading/errors,
   keyboard feedback and current source/version; no fake AI-generation button.
   Verify download/import references and built-image asset presence.
10. Update active client/reference/setup documentation together, including stale
    read-only adoption examples now offering explicitly requested content saves.
    Preserve intentional transports and the historical research report. Use
    generic placeholders; do not hard-code SEHA counts, contacts, private
    workbook names, tunnel URLs, tokens or investigation artifacts in assets.
    Authorized runtime setup may display/copy the current public MCP resource
    separately; that is not a tenant-specific value embedded in a reusable kit.

## Customer prompt matrix

| Audience/task | Required useful output |
| --- | --- |
| Staff: activation backlog | Ranked departments, exact counts/coverage, suitable candidates and prioritized actions |
| Staff: champion learning | Exact suggested peers' used/created evidence and questions, not expertise claims |
| Staff: starter pack | Three suitable first tasks with agent, draft prompt, input, output and review |
| Staff: Office-to-agent | Exact Office-familiar/no-reported-agent cohort with ambiguity and window limits |
| Staff: hidden gems | Declared task fit, limited observed spread and missing outcome evidence |
| Staff: cross-entity transfer | Reusable workflow elements and real recipient data/access differences |
| Staff: task-specific peers | Permitted dated peer candidates grounded in exact evidence |
| Staff: trial-to-routine | Appropriate follow-up observations/questions, not abandonment assertions |
| Staff: maker activation | Created-versus-used evidence and introduction actions |
| Staff: access versus awareness | Known restrictions, unknown access and evidence-backed next steps |
| Staff: workflow bundle | Manual handoffs, draft prompts and review, not claimed execution |
| Staff: Microsoft versus local | Labelled task fit, origin, scope and unknown personal access |
| Staff: measurement | Aggregate baseline/follow-up, cohort/window drift and non-causal conclusions |
| Staff: executive brief | Five sponsor decisions with reach, rationale and evidence limits |
| Staff: evidence-quality backlog | Missing descriptions/data/links and concrete repair priorities |
| Staff: unmet workflow | Existing candidates or a qualified demand brief, not a speculative new agent |
| Employee: first step | Safe candidates and a beginner exercise |
| Employee: peer learning | Safe tenant-shared cards/permitted contacts, no staff metrics |
| Employee: Microsoft/local choice | Labelled candidate capabilities and unknown access |
| Employee: missing profile | Organization-wide permitted discovery/cards without guessed workplace |
| Staff: save | Actual brief/action IDs and truthful outcomes without sending messages |
| Staff: capture learning | Contributor-provided anonymized card, not fabricated successful use |
| Staff: progress | Authorized revision-safe assigned-action update or explicit conflict |
| Quality/recovery | Specific missing/stale/withheld/limit state and permitted recovery |

## Focused verification

Run current wire/schema/example/metadata tests once at this useful boundary.
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
npm run build --workspace frontend
npm run lint --workspace frontend
```

Add focused canonical-asset/package/employee-handoff tests in existing runners.
Assert exact initialize/tools-list/browser metadata equality and executable
recipes against real advertised schemas; preserve EndUser projection and write
annotations. Validate skill frontmatter/name/description and every packaged
reference. Compare actual copied/downloaded bytes with canonical assets, including
from the built app; source-file existence is not packaging proof.

Measure instructions/metadata and workflow calls/bytes; remove redundant prose
instead of clipping schemas/evidence. Deterministically check every prompt's
role/evidence/output contract. Attempt one real authorized existing-consumer
setup/task with the distributed assets; record host/model/connection and true
result. Keyword assertions or a handshake do not prove improved reasoning.
Phase 05 owns representative repeated model and integrated qualification.

## Production continuation

Obey [the binding production policy](./README.md#always-deploy-production-contract).
Guidance never supplies authorization. Keep client/harness limitations specific;
do not weaken authentication, require installing this kit for catalog use, add
acceptance/enable gates or create paid services for unavailable host evidence.
Phase 06 owns exact live rollout and delivered-guidance observations.

## Completion and next phase

Write `completions/04-ai-guidance-and-customer-starter-kit.md` using CONTRACT's
factual record fields and update campaign state. Include instruction/description
owners, canonical asset/corpus paths, packaged contents/hashes, wire/metadata
proof, all prompt checklists, official platform sources/date and real-client
results/limitations.

Done means the running-source guidance and built customer assets are coherent,
role-aware, executable and actually deliverable. Phase 05 receives those exact
distributed assets and source identity, not a second guidance proposal.
