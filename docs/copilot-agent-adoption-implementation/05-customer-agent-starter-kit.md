# 05 - Customer agent starter kit

## Mission and prerequisites

Provide customers with practical instructions, an adoption skill where their
host supports it, verified setup guidance, and sample prompts for an AI consumer
connected to Agent Control. Deliver copy/download assets in the existing app;
do not merely add internal documentation.

Prerequisite: phase 04 and its actual implemented contracts; read all relevant
01-04 records, campaign state, [README](./README.md), and [CONTRACT](./CONTRACT.md).

## Read first

- [Customer connection guide](../mcp-clients.md),
  [Studio connection contract](../copilot-studio-mcp-connection.md),
  [client examples](../../mcp/examples/clients/).
- [Metadata settings component](../../frontend/src/components/McpSettings.tsx),
  [component tests](../../frontend/src/components/McpSettings.test.tsx),
  [API metadata type](../../backend/src/types/mcpSettings.ts).
- [MCP instruction owner](../../mcp/src/agent_control_mcp/instructions.py),
  [current native domains](../../mcp/src/agent_control_mcp/domains.py).
- [Research skill design](../copilot-agent-adoption-intelligence/05-ai-agent-skill-design.md),
  [use cases](../copilot-agent-adoption-intelligence/02-adoption-use-cases.md),
  [prompt library](../copilot-agent-adoption-intelligence/04-prompt-library.md).
- [App build packaging](../../Dockerfile), frontend asset/import patterns, and
  applicable agent-customization guidance.
- Current official Microsoft links in CONTRACT, including the selected
  harness's skill-create/import instructions and OAuth connection flow.

The app image does not automatically include arbitrary repository Markdown.
Choose one canonical checked-in asset owner that existing build/runtime paths
can actually deliver; do not keep independently edited UI/doc/skill copies.

## Required customer deliverables

1. **General Agent Control system instructions:** copy-ready purpose,
   current-tool use, actual caller scope, saved evidence/navigation, context/
   paging, uncertainty, privacy/injection handling and explicit write/control
   boundaries. Suitable beyond adoption; no tenant-specific data or credentials.
2. **Adoption-team instructions:** a concise specialization for department
   activation, peer learning, starter packs, saved actions and follow-up.
   Staff authority must come from the connection, not instruction text.
3. **Employee discovery instructions:** a safe task-first variant for roleless
   users, workplace/catalog/cards and permitted contacts; no staff counts or
   synthetic impersonation.
4. **One focused adoption skill:** the actual `SKILL.md` and small, linked
   evidence dictionary, tested retrieval recipes and output templates. Bundle
   MCP-navigation knowledge inside this skill instead of creating overlapping
   generic/adoption skills. Include installable packaging for verified hosts.
5. **Copilot Studio setup guide and compatibility matrix:** chosen harness,
   currently supported transport, OAuth/resource/client callback, connection
   identity, instructions placement, skill support, test pane and publication
   checks. Explain what is and is not verified.
6. **Sample prompt library:** task prompts with role, prerequisites, expected
   output, evidence cautions and explicit save behavior.
7. **Customer-facing app delivery:** an extension of existing MCP settings/setup
   with copy-ready instructions, copyable prompts and downloadable actual assets.
   Roleless users receive only appropriate employee guidance through their
   current conversational/discovery handoff, not the staff metadata catalog.

## Concrete work

1. Author the assets against delivered current operations, not the research
   document's internal-name examples. Separate general policy, tool procedures,
   adoption workflow and user prompts to avoid a giant repeated system prompt.
2. Make instructions adaptive to the actual advertised caller scope. Do not
   require an employee to obtain Viewer, invent a role, or route an employee
   agent through a shared Admin connection. Assignment/card sharing is not
   permission escalation.
3. Recheck current Studio documentation and record access date/harness-specific
   support. Use native skill import where verified. For hosts without that
   feature, provide the same compact workflow in supported agent instructions/
   actions, not an assertion that MCP auto-loads Markdown or prompts.
4. Preserve host-native answer-source formatting. Ground source dates/IDs and
   returned links in ordinary structured output without changing Studio's
   system-defined citation format.
5. Keep the consumer useful when a source, workplace, personal access or skill
   feature is unavailable. Explain exact missing evidence and continue supported
   catalog/Office/read paths; no invented HTTP/SQL proxies or hidden tools.
6. Author novice and experienced-user prompt variants. At minimum cover:

   | Audience/task | Sample prompt goal | Expected output |
   | --- | --- | --- |
   | Staff: activation backlog | Identify the largest actionable department opportunities | Counts/coverage, agents/peers, prioritized actions |
   | Staff: champion learning | Prepare interviews for an exact department's suggested peers | Used/created evidence and workflow questions, not expertise claims |
   | Staff: starter pack | Give a department three suitable first tasks | Agent, draft prompt, inputs, expected output and review steps |
   | Staff: Office-to-agent | Find Office-familiar audiences without selected-report agent evidence | Exact cohort and relevant next-step workflows |
   | Staff: hidden gems | Find useful but narrowly used agents | Declared task fit, reach and missing outcome evidence |
   | Staff: cross-entity transfer | Adapt a workflow to another entity | Reusable elements and real data/access differences |
   | Staff: task-specific peers | Find colleagues relevant to a budgeting/reporting task | Permitted, dated peer candidates with exact evidence |
   | Staff: trial-to-routine | Identify appropriate follow-up candidates | Observations and questions, not abandonment claims |
   | Staff: maker activation | Connect existing local agents to appropriate audiences | Created-versus-used evidence and introduction actions |
   | Staff: access versus awareness | Separate verified access issues from discovery/training gaps | Known restrictions, unknowns and evidence-backed next steps |
   | Staff: workflow bundle | Design a month-end workflow using existing agents | Manual handoffs, prompts and review steps, not claimed execution |
   | Staff: Microsoft versus local | Compare appropriate first-party and local options | Task fit, scope and real access caveats |
   | Staff: measurement | Assess a workshop's later participation evidence | Baseline/follow-up windows and non-causal conclusions |
   | Staff: executive brief | Give five useful sponsor decisions | Actions, reach, rationale and evidence limits |
   | Staff: evidence-quality backlog | Find gaps weakening recommendations | Missing data/descriptions/links and repair priorities |
   | Staff: unmet workflow | Search existing solutions before proposing a new agent | Existing candidates or a qualified demand brief |
   | Employee: first step | Help with a task using suitable available evidence | Safe candidate agents and a beginner exercise |
   | Employee: peer learning | What has my department shared that could help this task? | Safe cards and permitted peer guidance, no counts |
   | Employee: Microsoft/local choice | Explain which type fits this business task | Labelled candidate capabilities and unknown access |
   | Employee: missing profile | Help me even if workplace is not saved | Organization-wide safe task discovery |
   | Staff: save | Save this brief and proposed actions without sending messages | Record IDs, visible saved content and truthful write results |
   | Staff: capture learning | Save a contributor-provided anonymized workflow | Evidence-labelled card, not fabricated successful use |
   | Staff: progress | Update my assigned action's progress | Authorized revision-safe update or explicit conflict |
   | Quality/recovery | Handle missing report, stale selection or withheld identity | Specific limitation and supported recovery without bypass |

7. Use placeholders/generic company names in distributable assets. Do not
   package SEHA counts, employee contacts, private workbook names, tokens,
   internal tunnel URLs or investigation artifacts into the customer kit.
8. For every prompt, define a measurable response checklist and where the
   evidence comes from. Drafts must never be labelled actual employee prompts,
   verified outcomes, expertise, access or ROI.
9. Wire copy/download UI to the canonical assets and current non-secret
   deployment connection values. Provide visible errors, keyboard accessibility,
   role-appropriate variants and current-source/version identification.
   Ensure packaged references resolve after download/import and in built images.
10. Remove replaced active customer examples/instructions together, retaining
    intentional existing client transports. Keep historical research separate.
    Do not create a new paid agent/service or force the implementation worker
    model choice onto customer consumers.

## Focused verification

Validate skill name/description/frontmatter, all packaged local references and
the actual chosen host format. Contract-test recipes/sample tool inputs against
current advertised schemas and privacy projections. Test roleless/staff UI
variants and exact copy/download contents.

From repository root:

```sh
npm run test --workspace frontend -- src/components/McpSettings.test.tsx
npm run typecheck --workspace frontend
npm run build --workspace frontend
npm run lint --workspace frontend
```

From `mcp/`:

```sh
.venv/bin/python -m pytest tests/test_client_examples.py tests/test_workflows.py tests/test_settings_metadata.py
```

Add focused asset/package tests in the existing runners. Inspect built app/
download output rather than proving only that source files exist.
Attempt one real current-consumer setup/task and record actual host/model/
connection identity; phase 06 owns broad end-to-end qualification.

## Production continuation

Obey [the binding production policy](./README.md#always-deploy-production-contract).
Client/harness limitations stay specific and truthful. Native provider
connection/consent/publication requirements are not app-owned adoption gates.
Do not weaken authentication, claim unsupported skill loading, or gate catalog
use on installing this kit.

## Completion and next phase

Write `completions/05-customer-agent-starter-kit.md` and update campaign state.
Record asset owner, packaged files, exact installation/copy/download behavior,
platform sources/date, schema-tested prompts and real-client evidence.

Done means customers receive usable current assets through the built app and
documented installation paths, with all sixteen staff use cases and employee/
save/recovery examples covered. Phase 06 can run those exact distributed assets.
