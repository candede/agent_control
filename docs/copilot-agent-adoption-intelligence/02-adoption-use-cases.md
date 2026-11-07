# Adoption use cases

## Goal

Produce actionable knowledge for an enterprise Copilot adoption team:

> Who could benefit, from which task and agent, supported by which relevant
> colleague, for what evidence-backed reason, and with what follow-up measure?

The outputs below use the combined application evidence. Not every aggregate
is currently exposed directly through MCP; see
[MCP improvements](./06-mcp-improvements-and-evidence-gaps.md).

## Use cases, outputs, benefits, and prompts

| Use case | Output | How it helps adoption | Prompt starter |
| --- | --- | --- | --- |
| **1. Department activation backlog** | Prioritized departments, eligible target cohorts, participation, relevant agents, peer candidates, and next actions | Directs limited adoption-team capacity toward actionable opportunities | "Identify the highest-value department activation opportunities and explain the evidence behind each." |
| **2. Local champion knowledge harvesting** | Interview briefs prefilled with agents used/created, declared capabilities, and questions about successful workflows | Converts isolated expertise into transferable knowledge, not just a list of prolific users | "Prepare use-case interviews for Finance's suggested champions." |
| **3. Department starter packs** | Three suitable agents, a first task, draft prompt, required inputs, expected output, and help contact | Solves "I don't know where to begin" | "Create a beginner-friendly agent starter pack for Finance." |
| **4. Office Copilot to agents pathway** | Recommendations connecting familiar Office activities to relevant agent workflows | Builds on existing confidence rather than restarting training | "Find Office-active colleagues without reported agent use and propose suitable next-step workflows." |
| **5. Hidden-gem discovery** | Agents with concentrated usage, useful descriptions, limited spread, and potential recipient groups | Finds valuable local workflows that have not travelled beyond their initial users | "Find useful agents with strong but narrowly concentrated usage." |
| **6. Cross-company/function transfer** | Donor and recipient groups, reusable workflow, agent suitability, and data/context differences | Spreads learning between Finance teams, hospitals, or other comparable functions | "Find Finance workflows that could transfer between SEHA entities without assuming shared data access." |
| **7. Task-specific peer matching** | Candidate mentors for budgeting, analysis, writing, presentations, or other tasks, with evidence | A relevant colleague is more useful than a generic organization-wide champion | "Identify peers who could demonstrate budget analysis and management reporting." |
| **8. Trial-to-routine investigation** | Low-exposure or disappearing-report candidates, likely workflow fit, and diagnostic questions | Helps distinguish experimentation, occasional legitimate use, and unresolved friction | "Identify adoption follow-up candidates without labelling missing activity as abandonment." |
| **9. Maker-to-audience activation** | Created-versus-used agents, potential audiences, description gaps, and introduction opportunities | Helps local makers reach colleagues who could benefit | "Which locally created agents deserve clearer positioning or a department introduction?" |
| **10. Access versus awareness diagnosis** | Separate lists for known access restrictions, unknown access, discovery gaps, and training opportunities | Avoids prescribing training when the real issue is permissions, or assuming permissions are the problem | "Separate evidence-backed access issues from awareness and training opportunities." |
| **11. Workflow bundles** | A manual sequence such as analysis, commentary, report, and presentation, with handoff instructions | Makes agents useful in an actual business process instead of isolated demonstrations | "Design a month-end reporting workflow using suitable existing agents." |
| **12. Microsoft versus local-agent guidance** | Task-by-task comparison of first-party agents and specialized local agents | Helps people choose and prevents unnecessary rebuilding of capabilities already available | "For these Finance tasks, explain when Microsoft agents or local agents are the better starting point." |
| **13. Campaign measurement** | Baseline cohort, subsequent reported participation, repeat participation, spread, and evidence limitations | Measures breadth and sustained engagement rather than response volume alone | "Assess changes after our workshop, without claiming causality from usage snapshots." |
| **14. Executive adoption brief** | Five decisions/actions, underserved functions, successful patterns worth spreading, and confidence warnings | Gives sponsors something to act on rather than another chart | "Produce an executive adoption brief focused on decisions and next actions." |
| **15. Adoption evidence-quality backlog** | Missing descriptions/categories, stale sources, unresolved links, report discrepancies, and impact on recommendations | Improves trust and reduces poor AI recommendations | "Identify evidence gaps that most weaken adoption recommendations." |
| **16. Unmet-workflow discovery** | Existing-agent search results plus a draft problem brief for genuinely uncovered needs | Connects agent building to validated demand, not merely more agents | "Given these department tasks, identify existing solutions before proposing a new agent." |

## Required distinctions

Each output should distinguish:

1. **Observed usage:** what the selected saved reports establish.
2. **Declared capabilities:** what a complete permitted description says.
3. **Inferred opportunities:** task fit or potential recipients proposed by the AI.
4. **Newly generated material:** draft prompts, exercises, outreach, or workflow
   instructions.
5. **Validated learning:** successful work and outcomes confirmed by a
   contributor or other appropriate evidence.
6. **Unknown or withheld evidence:** missing coverage, ambiguous identity, stale
   sources, privacy restrictions, and unverified access.

Never present an inference or generated prompt as something an employee
actually did.

## Additional knowledge collection

Some deliverables need more than current telemetry:

| Desired knowledge | Additional evidence needed |
| --- | --- |
| A successful, transferable use case | A willing user's actual task, anonymized example, successful prompt, review steps, and limitations |
| Why adoption is missing | Lightweight feedback about awareness, task fit, friction, preferences, or actual access issues |
| Campaign effectiveness | A campaign/participant record, baseline, follow-up, and compatible observation windows |
| Productivity or ROI | Measured outcomes or time evidence, with an appropriate comparison and limitations |
| A new-agent business case | Validated demand and a search for existing solutions, not absence of reported use alone |

Knowledge capture should be lightweight. It must not become an approval or
certification gate before employees can discover or use supported agents.

## Output contracts

### Activation action

- Proposed owner.
- Target company/department and cohort.
- Evidence and observation/report context.
- Recommended next step.
- Relevant agent and peer candidates.
- Access or data-context caveats.
- Proposed success measure.
- Confidence and missing evidence.

### Use-case card

Business problem -> agent -> inputs -> draft prompt -> expected output ->
review steps -> permitted peer contact -> access/context caveats -> evidence ->
follow-up measure.

### Transfer brief

Explain what can be reused: the workflow, learning material, prompt pattern, or
agent. Do not assume that the same source data, knowledge workbook, or
permissions apply in the recipient entity.

### Measurement brief

Prefer breadth and repeat participation alongside volume. "First observed in
retained reports" is not "first use ever"; missing later evidence is not proof of
abandonment. Snapshot comparisons do not, by themselves, prove campaign
causality.

## Suggested initial deliverables

Start with:

1. Department activation briefs.
2. Peer-derived use-case playbooks.
3. Office-to-agent starter pathways.

The [Finance example](./03-finance-activation-example.md) demonstrates all three.
